/** What the approval pane draws. Never holds a secret value, only names and flags. */
export type SecretRequest = {
  id: string
  command: string
  names: string[]
  /** Names that have a value staged for this command. */
  ready: string[]
  /** Names that have a value remembered from earlier in this session. */
  remembered: string[]
  /** Keep the values in memory for later commands this session. */
  remember: boolean
  note?: string
}

declare module 'claude-code' {
  interface PluginState {
    'secret-broker': { request: SecretRequest | null; nudge: boolean }
  }
}
