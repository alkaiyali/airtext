import { describe, expect, it } from 'vitest'
import { classifyCameraError, decodeFrameSize } from './qrScanner'

function failure(name: string) {
  return classifyCameraError(new DOMException('test', name))
}

describe('classifyCameraError', () => {
  it('maps a blocked permission', () => {
    expect(failure('NotAllowedError').kind).toBe('permission')
  })
  it('maps a missing camera', () => {
    expect(failure('NotFoundError').kind).toBe('no-camera')
    expect(failure('OverconstrainedError').kind).toBe('no-camera')
  })
  it('maps a busy camera', () => {
    expect(failure('NotReadableError').kind).toBe('busy')
  })
  it('maps an insecure context', () => {
    expect(failure('SecurityError').kind).toBe('insecure')
  })
  it('falls back to unknown for anything else', () => {
    expect(classifyCameraError(new Error('nope')).kind).toBe('unknown')
  })
})

describe('decodeFrameSize', () => {
  it('downscales a landscape camera frame to the decode edge', () => {
    expect(decodeFrameSize(1280, 720)).toEqual({ width: 640, height: 360 })
  })
  it('scales a portrait camera frame by its long edge', () => {
    expect(decodeFrameSize(720, 1280)).toEqual({ width: 360, height: 640 })
  })
  it('never upscales a frame smaller than the decode edge', () => {
    expect(decodeFrameSize(320, 240)).toEqual({ width: 320, height: 240 })
  })
  it('keeps an empty frame decodable', () => {
    expect(decodeFrameSize(0, 0)).toEqual({ width: 1, height: 1 })
  })
})
