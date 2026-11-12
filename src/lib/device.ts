import type { DeviceKind } from '../types'

export function preferredDevice(): DeviceKind {
  return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 720 ? 'phone' : 'desktop'
}
