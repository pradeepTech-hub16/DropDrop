// `id` is what the backend stores (must match backend/src/utils/validation.js LANGUAGES);
// `label` is what the UI shows and what CodeMirror's language-data matches against.
export const LANGUAGES = [
  { id: 'plaintext', label: 'Plain text' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'json', label: 'JSON' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'sql', label: 'SQL' },
  { id: 'java', label: 'Java' },
  { id: 'cpp', label: 'C++' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'shell', label: 'Shell' },
]

export const labelFor = (id) => LANGUAGES.find((l) => l.id === id)?.label ?? 'Plain text'
