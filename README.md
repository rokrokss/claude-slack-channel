# Claude Slack Channel

Claude Code 세션과 Slack을 양방향으로 연결합니다. Slack DM이나 채널 멘션으로 Claude Code와 대화할 수 있습니다.

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code (Host)                       │
│                                                                 │
│   Claude LLM  ◄──── <channel> notification ◄──── stdout        │
│       │                                            ▲            │
│       │ tool call (reply/react/...)                 │            │
│       ▼                                            │            │
│     stdin ────► server.ts (MCP Server) ────► mcp.notification() │
│                    │           ▲                                 │
│                    │           │                                 │
│                    ▼           │                                 │
│              Slack Web API   Socket Mode (WebSocket)             │
│                    │           │                                 │
└────────────────────┼───────────┼────────────────────────────────┘
                     │           │
                     ▼           │
              ┌──────────────────┴──────┐
              │      Slack Platform     │
              │  (채널, DM, 스레드)       │
              └─────────────────────────┘
```

- **전송 프로토콜**: MCP (Model Context Protocol) over stdio
- **인바운드**: Slack → WebSocket(Socket Mode) → `server.ts` → `mcp.notification()` → stdout → Claude
- **아웃바운드**: Claude → tool call → stdin → `server.ts` → Slack Web API → Slack
- `console.error`만 디버그 로그에 사용 (stdout은 MCP 전용)

## 인바운드 메시지 파이프라인

Slack에서 메시지가 들어오면 6단계 파이프라인을 거칩니다. 각 단계에서 조건을 만족하지 않으면 메시지를 drop합니다.

```
Slack Event (message / app_mention)
        │
        ▼
  ┌─────────────┐
  │  1. Dedup   │──── 이미 처리한 이벤트? ──── drop
  └──────┬──────┘
         │ 새 이벤트
         ▼
  ┌─────────────┐
  │  2. Stale   │──── 10분 이상 된 이벤트? ──── drop
  └──────┬──────┘
         │ 최근 이벤트
         ▼
  ┌─────────────┐
  │  3. Empty   │──── 텍스트/파일/블록 없음? ──── drop
  └──────┬──────┘
         │ 내용 있음
         ▼
  ┌─────────────┐
  │  4. Gate    │──── 봇 자신? subtype 불허? ──── drop
  │  (접근제어)  │──── allowlist에 없음? ──────── drop
  └──────┬──────┘
         │ 허용된 사용자
         ▼
  ┌──────────────┐
  │ 5. Rate Limit│──── 채널당 한도 초과? ──── drop
  └──────┬───────┘
         │ 통과
         ▼
  ┌─────────────┐
  │  6. Deliver │──── permalink 생성
  │             │──── ack reaction 추가
  │             │──── mcp.notification() → Claude
  └─────────────┘
```

## 아웃바운드 도구

Claude가 사용할 수 있는 MCP 도구 5개:

```
Claude (tool call)
    │
    ├── reply ──────────── 메시지 전송 (+ 파일 첨부)
    │                      chat.postMessage → mrkdwn 포맷 변환
    │                      파일: filesUploadV2
    │                      ack reaction 자동 제거
    │
    ├── react ─────────── 이모지 리액션 추가
    │                      reactions.add
    │
    ├── remove_reaction ── 이모지 리액션 제거
    │                      reactions.remove
    │
    ├── delete_bot_message ── 봇 메시지 삭제
    │                         chat.delete (자기 메시지만)
    │
    └── fetch_dm_thread ── DM 스레드 읽기
                           conversations.replies
                           (is_dm=true일 때만 사용)
```

모든 아웃바운드 호출은 **audit log**에 기록되며, **outbound gate**를 통과해야 합니다 (인바운드를 받은 채널에만 응답 가능).

## 보안 레이어

```
┌─────────────────────────────────────────────────────┐
│                   Inbound Security                   │
│                                                     │
│  Allowlist Gate ── SLACK_ALLOW_FROM에 등록된          │
│                    사용자만 Claude에 메시지 전달        │
│                                                     │
│  Bot Owner ────── SLACK_BOT_OWNER는 항상 허용          │
│                                                     │
│  Self-loop ────── 봇 자신의 메시지 자동 drop           │
│                                                     │
│  Dedup ────────── 중복 이벤트 필터링 (TTL 10분)        │
│                                                     │
│  Rate Limit ───── 채널당 슬라이딩 윈도우               │
│                   (기본: 60초당 10건)                  │
├─────────────────────────────────────────────────────┤
│                  Outbound Security                   │
│                                                     │
│  Outbound Gate ── 인바운드 수신 이력이 있는             │
│                   채널에만 응답 허용                    │
│                                                     │
│  File Guard ───── state 디렉토리 파일 전송 차단         │
│                   (inbox/ 하위만 허용)                 │
│                                                     │
│  Prompt Hardening ── 시스템 프롬프트에서                │
│                      설정 변경 요청 거부                │
└─────────────────────────────────────────────────────┘
```

## 프로젝트 구조

```
server.ts          MCP 서버, Slack 클라이언트, 이벤트 핸들링
lib.ts             순수 함수 (gate, security, formatting, audit, event helpers)
server.test.ts     lib.ts 테스트 (bun:test, 93개)
```

## 데이터 흐름 상세

### Permission Request 흐름

도구 실행에 권한 확인이 필요할 때 Slack으로 알림을 보냅니다:

```
Claude Code ──► permission_request notification
                        │
                        ▼
               server.ts 수신
                        │
                        ▼
          마지막 inbound 채널/스레드로
          Slack 알림 전송 (경고색 #f0ad4e)
                        │
                        ▼
              사용자가 Slack에서 확인
              (승인/거부는 터미널에서)
```

### Ack Reaction 흐름

메시지 수신 확인과 답장 완료를 이모지로 표시합니다:

```
메시지 수신 ──► ack reaction 추가 (예: 👀)
                      │
                      ▼
              Claude가 처리 중...
                      │
                      ▼
              reply 도구 호출 시
              ack reaction 자동 제거
```

## 기존 Slack App에 추가 설정

이미 Slack App이 있다면 (예: slack MCP 서버용), 같은 앱에 아래 설정을 추가합니다.

### 1. Socket Mode 활성화

1. [api.slack.com/apps](https://api.slack.com/apps) → 앱 선택
2. **Settings → Socket Mode** → Enable
3. App-Level Token 생성 → `connections:write` 스코프 → `xapp-...` 토큰 복사

### 2. Event Subscriptions 활성화

**Event Subscriptions** → Enable → Bot Events 구독:
- `message.im` — DM
- `message.channels` — 공개 채널
- `message.groups` — 비공개 채널
- `app_mention` — @ 멘션

### 3. Bot Token Scopes 추가

**OAuth & Permissions** → Bot Token Scopes에 추가:
- `chat:write` — 메시지 전송
- `channels:history` — 공개 채널 읽기
- `groups:history` — 비공개 채널 읽기
- `im:history` — DM 읽기
- `reactions:write` — 리액션 추가/제거
- `files:read` — 파일 다운로드
- `files:write` — 파일 업로드
- `users:read` — 사용자 이름 확인

### 4. 워크스페이스에 재설치

**OAuth & Permissions** → **Reinstall to Workspace** → Bot Token (`xoxb-...`) 복사

## 설치 및 설정

프로젝트 `.mcp.json` 또는 `~/.claude.json`에 추가합니다:

```json
{
  "mcpServers": {
    "slack-channel": {
      "command": "bunx",
      "args": ["@rokrokss/claude-slack-channel"],
      "env": {
        "SLACK_BOT_TOKEN": "xoxb-...",
        "SLACK_APP_TOKEN": "xapp-...",
        "SLACK_ALLOW_FROM": "U123,U456",
        "SLACK_WORKSPACE": "your-workspace",
        "SLACK_ACK_REACTION": "eyes"
      }
    }
  }
}
```

| 환경변수 | 필수 | 설명 |
|---|---|---|
| `SLACK_BOT_TOKEN` | O | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | O | App-Level Token (`xapp-...`) |
| `SLACK_ALLOW_FROM` | O | 허용할 Slack 사용자 ID (쉼표 구분) |
| `SLACK_WORKSPACE` | O | Slack 워크스페이스 서브도메인 (예: `msuniverse`). permalink 생성에 사용 |
| `SLACK_BOT_OWNER` | X | 봇 소유자 사용자 ID. allowlist 없이도 항상 허용 |
| `SLACK_ACK_REACTION` | X | 수신 확인 이모지 (예: `eyes`). 답장 후 자동 제거 |
| `SLACK_DEFAULT_COLOR` | X | 메시지 사이드바 색상 hex (기본: `#e5da9a`) |
| `SLACK_RATE_LIMIT_MAX` | X | 채널당 최대 이벤트 수 (기본: `10`) |
| `SLACK_RATE_LIMIT_WINDOW_MS` | X | Rate limit 윈도우 (ms, 기본: `60000`) |

허용된 사용자는 DM이든 채널이든 어디서든 봇과 대화할 수 있습니다.

## 실행

```bash
claude --dangerously-load-development-channels server:slack-channel
```

## 개발

```bash
bun test          # 테스트 실행 (93개)
bun run typecheck # 타입 체크
```

## 라이선스

MIT
