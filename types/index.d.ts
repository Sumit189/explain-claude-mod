export type Mode = 'ste' | 'diagram' | 'html' | 'video' | null
export type Preview = { png: string; page: string; jpg: string | null; view: string | null; isVideo: boolean; generation: number } | null

declare module 'claude-code' {
  interface PluginState {
    'explain-as': { mode: Mode; isPickerOpen: boolean; preview: Preview; view: { zoom: number; x: number; y: number } }
  }
}
