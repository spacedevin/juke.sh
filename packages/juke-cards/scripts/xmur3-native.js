// Exact port of lib/card-art.ts xmur3 + getContrast — kept in JS because Tish
// lacks >>> and the Tish-safe rotate approximation changes style selection.
export function xmur3(str) {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return (h ^ (h >>> 16)) >>> 0
  }
}

export function getContrast(hex) {
  if (!hex || hex[0] !== '#') return '#000000'
  const r = parseInt(hex.substr(1, 2), 16)
  const g = parseInt(hex.substr(3, 2), 16)
  const b = parseInt(hex.substr(5, 2), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? '#000000' : '#ffffff'
}
