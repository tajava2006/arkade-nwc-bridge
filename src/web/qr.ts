import encodeQR from 'qr'

export function qrSvg(data: string): string {
  return encodeQR(data, 'svg')
}
