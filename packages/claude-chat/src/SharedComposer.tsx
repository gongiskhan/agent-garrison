import * as React from 'react';
import { forwardRef } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

export interface ComposerAttachment { id: string; name: string; path: string | null; uploading: boolean; error: string | null; previewUrl: string | null }
export function clipboardFiles(data: DataTransfer | null): File[] { return Array.from(data?.items || []).filter(item => item.kind === 'file').flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; }); }
export async function readComposerUpload(file: File): Promise<{ name: string; mime: string; base64: string }> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => { const value = String(reader.result || ''); resolve({ name: file.name || 'pasted-image.png', mime: file.type || 'application/octet-stream', base64: value.slice(value.indexOf(',') + 1) }); }; reader.onerror = () => reject(new Error('read failed')); reader.readAsDataURL(file); }); }
export const SharedComposerInput = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { attachmentsEnabled?: boolean; onFiles?: (files: File[]) => void }>(function SharedComposerInput({ attachmentsEnabled = false, onFiles, onPaste, ...props }, ref) {
  return <textarea {...props} ref={ref} onPaste={event => { if (attachmentsEnabled && onFiles) { const files = clipboardFiles(event.clipboardData); if (files.length) { event.preventDefault(); onFiles(files); return; } } onPaste?.(event); }} />;
});
export const SharedComposerFileInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange'> & { onFiles: (files: File[]) => void }>(function SharedComposerFileInput({ onFiles, ...props }, ref) {
  return <input {...props} ref={ref} type="file" onChange={event => { if (event.target.files?.length) onFiles(Array.from(event.target.files)); event.target.value = ''; }} />;
});
export function ComposerAttachmentChips({ attachments, onRemove, classNames = {} }: { attachments: ComposerAttachment[]; onRemove: (id: string) => void; classNames?: Partial<Record<'list' | 'chip' | 'error' | 'thumb' | 'icon' | 'name' | 'spinner' | 'errorMark' | 'remove', string>> }) {
  const css = { list: 'cc-attachments', chip: 'cc-attachment-chip', error: 'cc-attachment-chip-error', thumb: 'cc-attachment-thumb', icon: 'cc-attachment-icon', name: 'cc-attachment-name', spinner: 'cc-mic-spin', errorMark: 'cc-attachment-err', remove: 'cc-attachment-x', ...classNames };
  if (!attachments.length) return null;
  return <div className={css.list}>{attachments.map(attachment => <div key={attachment.id} className={`${css.chip}${attachment.error ? ` ${css.error}` : ''}`} title={attachment.error || attachment.name}>{attachment.previewUrl ? <img src={attachment.previewUrl} alt="" className={css.thumb} /> : <svg className={css.icon} width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h6l3 3v9H4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>}<span className={css.name}>{attachment.name}</span>{attachment.uploading && <span className={css.spinner} aria-label="Uploading" />}{attachment.error && <span className={css.errorMark} aria-hidden="true">!</span>}<button type="button" className={css.remove} aria-label={`Remove ${attachment.name}`} onClick={() => onRemove(attachment.id)}>×</button></div>)}</div>;
}
