# Claude Slack Channel

Claude Code 세션과 Slack을 양방향으로 연결하는 MCP 채널 서버입니다. Slack DM이나 채널 멘션으로 Claude Code와 대화할 수 있습니다.

## 설치

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
| `SLACK_BOT_OWNER` | - | 봇 소유자 사용자 ID. allowlist 없이도 항상 허용 |
| `SLACK_ACK_REACTION` | - | 수신 확인 이모지 (예: `eyes`). 답장 후 자동 제거 |
| `SLACK_DEFAULT_COLOR` | - | 메시지 사이드바 색상 hex (기본: `#e5da9a`) |
| `SLACK_SHOW_FOOTER` | - | 메시지 하단 footer 표시 여부 (기본: `true`). `false`로 설정 시 숨김 |
| `SLACK_FORCE_SOCKET_MODE` | - | `1`로 설정 시 플래그 감지를 건너뛰고 Socket Mode 강제 연결 |

## 실행

```bash
claude --dangerously-load-development-channels server:slack-channel
```

허용된 사용자는 DM이든 채널이든 어디서든 봇과 대화할 수 있습니다.

## 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                        Claude Code (Host)                       │
│                                                                 │
│   Claude LLM  <──── <channel> notification <──── stdout        │
│       │                                            ^            │
│       │ tool call (reply/react/...)                 │            │
│       v                                            │            │
│     stdin ────> server.ts (MCP Server) ────> mcp.notification() │
│                    │           ^                                 │
│                    │           │                                 │
│                    v           │                                 │
│              Slack Web API   Socket Mode (WebSocket)             │
│                    │           │                                 │
└────────────────────┼───────────┼────────────────────────────────┘
                     │           │
                     v           │
              ┌──────────────────┴──────┐
              │      Slack Platform      │
              │    (채널, DM, 스레드)      │
              └─────────────────────────┘
```

- **전송 프로토콜**: MCP (Model Context Protocol) over stdio
- **인바운드**: Slack → WebSocket(Socket Mode) → `server.ts` → `mcp.notification()` → stdout → Claude
- **아웃바운드**: Claude → tool call → stdin → `server.ts` → Slack Web API → Slack
- `console.error`만 디버그 로그에 사용 (stdout은 MCP 전용)

## 시작 흐름

```
main()
  │
  ├── hasChannelsFlag()
  │     └── 부모 프로세스(Claude Code)의 command line에서
  │         --dangerously-load-development-channels 또는 --channels 확인
  │
  ├── [플래그 있음] startSocketMode()
  │     ├── killPreviousInstance() → 기존 인스턴스 종료 (PID 파일)
  │     ├── writePidFile() → 자신의 PID 기록
  │     ├── web.auth.test() → botUserId 확인
  │     │     └── 실패 → process.exit(1)
  │     └── socket.start() → Slack 이벤트 수신 시작
  │
  ├── [플래그 없음] Socket Mode 스킵 (Tools-only mode)
  │
  └── mcp.connect(transport) → MCP stdio 연결
```

Socket Mode는 부모 프로세스(Claude Code)에 channels 플래그가 있을 때만 연결됩니다. 플래그 없이 실행된 세션은 도구만 제공하며 Socket Mode를 건드리지 않으므로, 기존 channels 세션의 연결이 보호됩니다.

### Channels 플래그 감지 (`hasChannelsFlag`)

Claude Code는 `--dangerously-load-development-channels` 또는 `--channels` 플래그와 함께 실행될 때만 채널 기능을 사용합니다. 이 MCP 서버는 부모 프로세스의 커맨드라인을 검사하여 플래그 존재 여부를 판단합니다.

```
hasChannelsFlag()
  │
  ├── SLACK_FORCE_SOCKET_MODE=1 ? ──── true (환경변수 오버라이드)
  │
  └── findAncestorClaudeCommand()
        │
        │  process.ppid부터 시작, 최대 5단계 탐색
        │
        v
  ┌──────────────────────────────────────────────────────┐
  │  PID 1234 (bun server.ts)                            │
  │    └── ppid -> PID 1230                              │
  │                                                      │
  │  PID 1230 (node ...)                                 │
  │    └── ppid -> PID 1225                              │
  │                                                      │
  │  PID 1225 (claude --channels server:slack)  <── 발견! │
  │    └── 커맨드라인에 "channels" 포함 -> true            │
  └──────────────────────────────────────────────────────┘
```

**프로세스 정보 조회 방법:**

| 플랫폼 | 명령 |
|---|---|
| macOS / Linux | `ps -o ppid=,command= -p <pid>` |
| Windows | `wmic process where ProcessId=<pid> get ParentProcessId,CommandLine /format:csv` |

각 단계에서 부모 PID와 커맨드라인을 함께 가져와, `claude`라는 이름의 프로세스를 찾으면 그 커맨드라인에서 플래그를 확인합니다. 5단계 안에 찾지 못하면 `false`를 반환하며, Socket Mode를 시작하지 않습니다.

**왜 이것이 중요한가:**

Claude Code는 하나의 앱에 대해 여러 세션을 열 수 있습니다. 플래그 없이 실행된 세션이 Socket Mode에 연결하면, 이미 연결된 channels 세션의 WebSocket을 끊어버립니다. 플래그 검사를 통해 일반 세션은 tools-only 모드로 동작하여 기존 channels 세션을 보호합니다.

```
세션 A: claude --channels server:slack    <- Socket Mode 연결 O
세션 B: claude                            <- Socket Mode 스킵 (tools-only)
세션 C: claude                            <- Socket Mode 스킵 (tools-only)
                                             세션 A의 연결은 안전하게 유지됨
```

### Socket Preemption (PID 파일 기반 단일 인스턴스 보장)

Slack Socket Mode는 **앱당 하나의 WebSocket 연결만** 허용합니다. 두 번째 연결이 생기면 첫 번째가 끊기며 이벤트가 유실될 수 있습니다. PID 파일(`~/.claude/channels/slack/socket.pid`)을 사용하여 항상 최신 인스턴스만 Socket Mode를 유지합니다.

```
인스턴스 A 시작                         인스턴스 B 시작
      │                                      │
      v                                      │
  PID 파일 없음                               │
      │                                      │
      v                                      │
  socket.pid <- A.pid 기록                    │
      │                                      │
      v                                      │
  Socket Mode 연결 O                          │
  이벤트 수신 중...                            │
      │                                      v
      │                              socket.pid 읽기 -> A.pid
      │                                      │
      │                                      v
      │                              kill(A.pid, 0) -> 생존 확인
      │                                      │
      │<──── SIGTERM ─────────────── kill(A.pid, SIGTERM)
      │                                      │
      v                                      v
  cleanupPidFile()                   socket.pid <- B.pid 기록
  PID 파일 정리 (자기 PID일 때만)              │
      │                                      v
      v                              Socket Mode 연결 O
  프로세스 종료                         이벤트 수신 중...
```

**PID 파일 안전 장치:**

- **생존 확인**: `process.kill(oldPid, 0)` — signal 0은 프로세스를 죽이지 않고 존재 여부만 확인합니다. 이미 종료된 프로세스에 SIGTERM을 보내는 것을 방지합니다.
- **소유권 확인**: `cleanupPidFile()`은 PID 파일의 내용이 자신의 PID일 때만 삭제합니다. 새 인스턴스가 이미 PID를 덮어썼다면 건드리지 않습니다.
- **종료 핸들링**: `exit`, `SIGTERM`, `SIGINT` 세 가지 시그널 모두에서 PID 파일을 정리합니다.

## 인바운드 메시지 파이프라인

Slack에서 메시지가 들어오면 5단계 파이프라인을 거칩니다. 각 단계에서 조건을 만족하지 않으면 메시지를 drop합니다.

```
Slack Event (message / app_mention)
        │
        v
  ┌─────────────┐
  │  1. Dedup   │──── 이미 처리한 이벤트? ──── drop
  └──────┬──────┘
         │ 새 이벤트
         v
  ┌─────────────┐
  │  2. Stale   │──── 10분 이상 된 이벤트? ──── drop
  └──────┬──────┘
         │ 최근 이벤트
         v
  ┌─────────────┐
  │  3. Empty   │──── 텍스트/파일/블록 없음? ──── drop
  └──────┬──────┘
         │ 내용 있음
         v
  ┌─────────────┐
  │  4. Gate    │──── 봇 자신? subtype 불허? ──── drop
  │  (접근제어)  │──── allowlist에 없음? ──────── drop
  └──────┬──────┘
         │ 허용된 사용자
         v
  ┌─────────────┐
  │  5. Deliver │──── permalink 생성
  │             │──── ack reaction 추가
  │             │──── mcp.notification() -> Claude
  └─────────────┘
```

## 아웃바운드 도구

Claude가 사용할 수 있는 MCP 도구:

| 도구 | 기능 | Slack API |
|---|---|---|
| `reply` | 메시지 전송 (mrkdwn 포맷 변환, ack reaction 자동 제거) | `chat.postMessage` |
| `react` | 이모지 리액션 추가 | `reactions.add` |
| `delete_bot_message` | 봇 자신의 메시지 삭제 | `chat.delete` |
| `fetch_dm_thread` | DM 스레드 내용 읽기 (`is_dm=true`일 때만 사용) | `conversations.replies` |

모든 아웃바운드 호출은 **audit log**에 기록되며, **outbound gate**를 통과해야 합니다 (인바운드를 받은 채널에만 응답 가능).

## 보안

```
┌───────────────────────────────────────────────────────┐
│                   Inbound Security                     │
│                                                       │
│  Allowlist Gate ── SLACK_ALLOW_FROM에 등록된            │
│                    사용자만 Claude에 메시지 전달          │
│                                                       │
│  Bot Owner ────── SLACK_BOT_OWNER는 항상 허용           │
│                                                       │
│  Self-loop ────── 봇 자신의 메시지 자동 drop             │
│                                                       │
│  Dedup ────────── 중복 이벤트 필터링 (TTL 10분)          │
│                                                       │
├───────────────────────────────────────────────────────┤
│                   Outbound Security                    │
│                                                       │
│  Outbound Gate ── 인바운드 수신 이력이 있는               │
│                   채널에만 응답 허용                      │
│                                                       │
│  Prompt Hardening ── 시스템 프롬프트에서                  │
│                      설정 변경 요청 거부                  │
└───────────────────────────────────────────────────────┘
```

## 데이터 흐름 상세

### Permission Request

도구 실행에 권한 확인이 필요할 때 Slack으로 알림을 보냅니다:

```
Claude Code ──> permission_request notification
                        │
                        v
               server.ts 수신
                        │
                        v
          마지막 inbound 채널/스레드로
          Slack 알림 전송 (경고색 #f0ad4e)
                        │
                        v
              사용자가 Slack에서 확인
              (승인/거부는 터미널에서)
```

### Ack Reaction

메시지 수신 확인과 답장 완료를 이모지로 표시합니다:

```
메시지 수신 ──> ack reaction 추가 (예: eyes)
                      │
                      v
              Claude가 처리 중...
                      │
                      v
              reply 도구 호출 시
              ack reaction 자동 제거
```

## Slack App 설정

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
- `users:read` — 사용자 이름 확인

### 4. 워크스페이스에 재설치

**OAuth & Permissions** → **Reinstall to Workspace** → Bot Token (`xoxb-...`) 복사

## 프로젝트 구조

```
server.ts          MCP 서버, Slack 클라이언트, 이벤트 핸들링
tools.ts           MCP 도구 등록 (reply, react, delete_bot_message, fetch_dm_thread)
lib/
  gate.ts          접근 제어 (Access, GateOptions, gate)
  process.ts       부모 프로세스 channels 플래그 감지 (hasChannelsFlag)
  security.ts      아웃바운드 게이트 (assertOutboundAllowed)
  formatting.ts    Slack mrkdwn 변환, 메시지 텍스트 추출
  audit.ts         감사 로그 (AuditEntry, auditLog)
  event.ts         DM 판별, 스레드 해석, stale/empty 필터링
  resilience.ts    이벤트 중복 제거 (EventDeduplicator)
  permalink.ts     Slack 퍼마링크 빌더
  index.ts         barrel re-export
server.test.ts     lib/ 테스트 (bun:test)
```

## 개발

```bash
bun test          # 테스트 실행
bun run typecheck # 타입 체크
```

## 라이선스

MIT
