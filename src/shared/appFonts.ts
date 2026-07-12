export interface AppFontOption {
  value: string
  label: string
  stack: string
}

export const APP_FONT_OPTIONS: AppFontOption[] = [
  { value: 'default', label: 'Default (Inter / Segoe UI)', stack: "'Inter', 'Segoe UI', system-ui, sans-serif" },
  { value: 'system', label: 'System UI', stack: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" },
  { value: 'aptos', label: 'Aptos', stack: "Aptos, 'Segoe UI', system-ui, sans-serif" },
  { value: 'segoe', label: 'Segoe UI', stack: "'Segoe UI', system-ui, sans-serif" },
  { value: 'arial', label: 'Arial', stack: "Arial, Helvetica, sans-serif" },
  { value: 'arial_narrow', label: 'Arial Narrow', stack: "'Arial Narrow', Arial, sans-serif" },
  { value: 'bahnschrift', label: 'Bahnschrift', stack: "Bahnschrift, 'Segoe UI', system-ui, sans-serif" },
  { value: 'calibri', label: 'Calibri', stack: "Calibri, 'Segoe UI', sans-serif" },
  { value: 'candara', label: 'Candara', stack: "Candara, 'Segoe UI', sans-serif" },
  { value: 'century_gothic', label: 'Century Gothic', stack: "'Century Gothic', 'Segoe UI', sans-serif" },
  { value: 'corbel', label: 'Corbel', stack: "Corbel, 'Segoe UI', sans-serif" },
  { value: 'franklin_gothic', label: 'Franklin Gothic', stack: "'Franklin Gothic Medium', 'Arial Narrow', Arial, sans-serif" },
  { value: 'gill_sans', label: 'Gill Sans', stack: "'Gill Sans', 'Gill Sans MT', Calibri, sans-serif" },
  { value: 'trebuchet', label: 'Trebuchet MS', stack: "'Trebuchet MS', 'Segoe UI', sans-serif" },
  { value: 'verdana', label: 'Verdana', stack: "Verdana, Geneva, sans-serif" },
  { value: 'tahoma', label: 'Tahoma', stack: "Tahoma, Geneva, sans-serif" },
  { value: 'lucida_sans', label: 'Lucida Sans', stack: "'Lucida Sans Unicode', 'Lucida Grande', sans-serif" },
  { value: 'cambria', label: 'Cambria', stack: "Cambria, Georgia, serif" },
  { value: 'constantia', label: 'Constantia', stack: "Constantia, Georgia, serif" },
  { value: 'georgia', label: 'Georgia', stack: "Georgia, 'Times New Roman', serif" },
  { value: 'garamond', label: 'Garamond', stack: "Garamond, 'Times New Roman', serif" },
  { value: 'palatino', label: 'Palatino', stack: "Palatino, 'Palatino Linotype', 'Book Antiqua', serif" },
  { value: 'times', label: 'Times New Roman', stack: "'Times New Roman', Times, serif" },
  { value: 'bookman', label: 'Bookman Old Style', stack: "'Bookman Old Style', Georgia, serif" },
  { value: 'cascadia', label: 'Cascadia Code', stack: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace" },
  { value: 'consolas', label: 'Consolas', stack: "Consolas, 'Courier New', monospace" },
  { value: 'courier', label: 'Courier New', stack: "'Courier New', Courier, monospace" },
]

export const APP_FONT_VALUES = APP_FONT_OPTIONS.map((font) => font.value)

export function appFontStack(value: string | null | undefined): string {
  return APP_FONT_OPTIONS.find((font) => font.value === value)?.stack ?? APP_FONT_OPTIONS[0].stack
}

export function normalizeAppFont(value: string | null | undefined): string {
  return APP_FONT_OPTIONS.some((font) => font.value === value) ? String(value) : APP_FONT_OPTIONS[0].value
}
