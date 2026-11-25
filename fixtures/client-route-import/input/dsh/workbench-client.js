import { CSS, renderMarkdown } from '/argo/workbench-md.js'

export function render(md) {
  return `<style>${CSS}</style>${renderMarkdown(md)}`
}
