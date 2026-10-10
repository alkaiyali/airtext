import { useEffect, useRef, useState } from 'react'
import { blobToDataUrl } from '../lib/clipboard'
import { downscaleToDataUrl } from '../lib/image'
import { ArrowUpRightIcon } from './icons'
import { MAX_IMAGE_BYTES, MAX_TEXT_LENGTH } from '../types'

interface ClipboardComposerProps {
  onShare: (text: string, image?: string) => Promise<void>
  /** False while the ECDH handshake is still running: sharing is gated. */
  canShare?: boolean
}

function CameraIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

function GalleryIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

function PasteIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  )
}

export function ClipboardComposer({ onShare, canShare = true }: ClipboardComposerProps) {
  const [text, setText] = useState('')
  const [image, setImage] = useState('')
  const [message, setMessage] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [isProcessingImage, setIsProcessingImage] = useState(false)
  // The file inputs stay hidden so the visible media controls can be real
  // buttons — focusable and in the tab order, unlike a hidden input.
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)

  async function attachBlob(blob: Blob): Promise<void> {
    if (!blob.type.startsWith('image/')) {
      setMessage('That file is not an image. Choose a photo or screenshot instead.')
      return
    }
    setIsProcessingImage(true)
    try {
      // Downscale camera photos so they fit the room budget; tiny icons fall
      // back to a plain data URL without recompression overhead.
      const dataUrl = blob.size > MAX_IMAGE_BYTES || blob.type === 'image/png'
        ? await downscaleToDataUrl(blob).catch(() => blobToDataUrl(blob))
        : await blobToDataUrl(blob)
      setImage(dataUrl)
      setMessage('')
    } catch {
      setMessage(`This image is still too large after compressing. Try a smaller one.`)
    } finally {
      setIsProcessingImage(false)
    }
  }

  // Catch Ctrl/⌘+V anywhere on the page, not just inside the textarea.
  useEffect(() => {
    function onWindowPaste(event: ClipboardEvent): void {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return
      const imageItem = Array.from(event.clipboardData?.items ?? []).find((item) => item.type.startsWith('image/'))
      if (!imageItem) return
      event.preventDefault()
      const blob = imageItem.getAsFile()
      if (blob) void attachBlob(blob)
    }
    window.addEventListener('paste', onWindowPaste)
    return () => window.removeEventListener('paste', onWindowPaste)
  }, [])

  async function pasteFromClipboard(): Promise<void> {
    if (!navigator.clipboard?.read) {
      setMessage('This browser cannot read the clipboard here. Use Ctrl/⌘+V instead.')
      return
    }
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imageType = item.types.find((type) => type.startsWith('image/'))
        if (imageType) {
          await attachBlob(await item.getType(imageType))
          return
        }
      }
      const pastedText = await navigator.clipboard.readText()
      setText(pastedText)
      setMessage('Pasted from this device.')
    } catch {
      setMessage('The browser blocked clipboard access. Allow it in site settings, or use Ctrl/⌘+V.')
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const imageItem = Array.from(event.clipboardData.items).find((item) => item.type.startsWith('image/'))
    if (!imageItem) return
    event.preventDefault()
    const blob = imageItem.getAsFile()
    if (blob) void attachBlob(blob)
  }

  function pickImage(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setMessage('That file is not an image. Choose a photo or screenshot instead.')
      return
    }
    void attachBlob(file)
  }

  function clearImage(): void {
    setImage('')
  }

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (isSending || !canShare) return
    const hasContent = text.trim().length > 0 || Boolean(image)
    if (!hasContent) return
    setIsSending(true)
    setMessage('')
    try {
      await onShare(text, image || undefined)
      setText('')
      clearImage()
      setMessage('Sent to your other device.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not share this item.')
    } finally {
      setIsSending(false)
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-label-row">
        <label htmlFor="clipboard-text">Share to the other device</label>
        <button className="text-button paste-button" type="button" onClick={pasteFromClipboard}><PasteIcon /> Paste from clipboard</button>
      </div>
      <textarea id="clipboard-text" value={text} onChange={(event) => setText(event.target.value)} onPaste={handlePaste} placeholder="Paste a link, note, or code — or type it here…" rows={4} maxLength={MAX_TEXT_LENGTH} />
      {image ? <div className="image-preview"><img src={image} alt="Attached preview" /><button className="text-button" type="button" onClick={clearImage}>Remove image</button></div> : null}
      <div className="composer-footer">
        <span className="composer-hint">{message || (canShare ? 'Text or image · text up to 100,000 characters · images compressed to fit 350 KB' : 'Setting up the secure channel…')}</span>
        <div className="composer-actions">
          <button className="media-button" type="button" title="Take a photo — compressed automatically to fit 350 KB" aria-label="Camera: take a photo" onClick={() => cameraInputRef.current?.click()} disabled={isProcessingImage}><CameraIcon /> {isProcessingImage ? 'Preparing…' : 'Camera'}</button>
          <button className="media-button" type="button" title="Choose an image from your gallery — compressed automatically to fit 350 KB" aria-label="Gallery: choose an image" onClick={() => galleryInputRef.current?.click()} disabled={isProcessingImage}><GalleryIcon /> Gallery</button>
          <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" onChange={pickImage} hidden />
          <input ref={galleryInputRef} type="file" accept="image/*" onChange={pickImage} hidden />
          <button className="primary-button" type="submit" disabled={(!text.trim() && !image) || isSending || isProcessingImage || !canShare}>{isSending ? 'Sharing…' : 'Share'} <ArrowUpRightIcon /></button>
        </div>
      </div>
    </form>
  )
}
