const tampaZone = 'America/New_York'
const fieldFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: tampaZone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

export function tampaInput(date: Date) {
  return fieldFormatter.format(date).replace(' ', 'T')
}

export function tampaToIso(value: string) {
  const wallTime = Date.parse(`${value}:00Z`)
  if (!Number.isFinite(wallTime)) throw new Error('Choose a valid date and start time.')
  // The two offsets cover Eastern Standard Time and Eastern Daylight Time.
  const candidates = [4, 5]
    .map(hours => new Date(wallTime + hours * 3_600_000))
    .filter(date => tampaInput(date) === value)
  if (candidates.length !== 1) throw new Error('Choose a time outside the daylight-saving transition hour.')
  return candidates[0].toISOString()
}

export function formatGameTime(iso: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tampaZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(iso))
}
