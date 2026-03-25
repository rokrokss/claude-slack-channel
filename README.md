# Claude Slack Channel

Claude Code 세션과 Slack을 양방향으로 연결합니다. Slack DM이나 채널 멘션으로 Claude Code와 대화할 수 있습니다.

## 작동 방식

Claude Code가 `server.ts`를 subprocess로 실행하고, **stdio**(stdin/stdout) 파이프로 양방향 통신합니다.

```
[인바운드: Slack → Claude]

  Slack 사용자가 메시지 전송
       │
       ▼
  Slack API (Socket Mode, WebSocket)
       │
       ▼
  server.ts가 이벤트 수신
       │  allowlist 확인 (gate)
       ▼
  mcp.notification() → stdout으로 JSON-RPC 전송
       │
       ▼
  Claude Code가 수신 → <channel source="slack-channel" ...> 태그로 세션에 주입
       │
       ▼
  Claude가 메시지를 읽고 처리


[아웃바운드: Claude → Slack]

  Claude가 reply 도구 호출을 결정
       │
       ▼
  Claude Code가 stdin으로 tool call 요청 전송
       │
       ▼
  server.ts의 reply 핸들러가 요청 수신
       │
       ▼
  Slack Web API (chat.postMessage) → Slack 채널에 메시지 전송
```

- **인바운드**: Slack → WebSocket → `server.ts` → `mcp.notification()` → stdout → Claude
- **아웃바운드**: Claude → tool call → stdin → `server.ts` → Slack Web API → Slack
- **전송 프로토콜**: MCP (Model Context Protocol) over stdio. `console.error`만 디버그 로그에 사용 (stdout은 MCP 전용)

Socket Mode를 사용하므로 공개 URL이 필요 없습니다. 방화벽 뒤에서도 동작합니다.

> **Research Preview** — Claude Code v2.1.80+ 및 claude.ai 로그인 필요.

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
| `SLACK_ACK_REACTION` | X | 수신 확인 이모지 (예: `eyes`). 답장 후 자동 제거 |
| `SLACK_DEFAULT_COLOR` | X | 메시지 사이드바 색상 hex (기본: `#e5da9a`) |

허용된 사용자는 DM이든 채널이든 어디서든 봇과 대화할 수 있습니다.

## 실행

```bash
claude --dangerously-load-development-channels server:slack-channel
```

## 보안

- **Allowlist gating**: 허용된 사용자만 Claude에 메시지 전달. 나머지는 무시
- **Outbound gate**: 인바운드 메시지를 받은 채널에만 응답 가능
- **File exfiltration guard**: state 디렉토리 파일 전송 차단
- **Prompt injection 방어**: 시스템 프롬프트에서 설정 변경 요청 거부
- **Self-loop prevention**: 자기 봇 메시지 자동 drop

## 라이선스

MIT
