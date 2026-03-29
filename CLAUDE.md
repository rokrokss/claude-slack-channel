# Claude Slack Channel 개발 가이드

## 프로젝트 구조

- `server.ts` — MCP channel 서버 (stateful: Slack 클라이언트, 이벤트 핸들링)
- `tools.ts` — MCP 도구 등록 (reply, react, delete_bot_message, fetch_dm_thread)
- `lib/` — 순수 함수 모듈
  - `gate.ts` — 접근 제어 (Access, GateOptions, gate)
  - `security.ts` — 아웃바운드 게이트 (assertOutboundAllowed)
  - `formatting.ts` — Slack mrkdwn 변환, 메시지 텍스트 추출
  - `audit.ts` — 감사 로그 (AuditEntry, auditLog)
  - `event.ts` — DM 판별, 스레드 해석, stale/empty 필터링
  - `resilience.ts` — 이벤트 중복 제거 (EventDeduplicator)
  - `permalink.ts` — Slack 퍼마링크 빌더
  - `process.ts` — 부모 프로세스 channels 플래그 감지 (hasChannelsFlag)
  - `index.ts` — barrel re-export
- `server.test.ts` — lib/ 테스트 (bun:test)

## 개발

```bash
bun test          # 테스트 실행
bun run typecheck # 타입 체크
```

## 참고

- Channels Reference: https://code.claude.com/docs/en/channels-reference
