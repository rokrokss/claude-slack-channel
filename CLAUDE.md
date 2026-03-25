# Claude Slack Channel 개발 가이드

## 프로젝트 구조

- `server.ts` — MCP channel 서버 (stateful: Slack 클라이언트, 도구 실행)
- `lib.ts` — 순수 함수 (gate, fixSlackMrkdwn, extractMessageText, sanitize, security)
- `server.test.ts` — lib.ts 테스트 (bun:test)

## 개발

```bash
bun test          # 테스트 실행
bun run typecheck # 타입 체크
```

## 참고

- Channels Reference: https://code.claude.com/docs/en/channels-reference
