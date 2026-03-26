export function assertOutboundAllowed(
  chatId: string,
  deliveredChannels: ReadonlySet<string>,
): void {
  if (deliveredChannels.has(chatId)) return
  throw new Error(
    `Outbound gate: channel ${chatId} has not received any inbound messages.`,
  )
}
