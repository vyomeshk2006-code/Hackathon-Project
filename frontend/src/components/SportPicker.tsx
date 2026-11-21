
import { createContext, useContext, useId, useState } from 'react'
import type { PropsWithChildren } from 'react'
import { useAction } from '../hooks/useAction'
import { useResource } from '../hooks/useResource'
import { pickup } from '../services'
import { seededSports } from '../types/domain'
import type { SportDefinition } from '../types/domain'
import { ActionNotice } from './ActionNotice'
import { LoadError } from './ui'

const CatalogContext = createContext<readonly SportDefinition[]>(seededSports)

export function CatalogProvider({ children }: PropsWithChildren) {
  const catalog = useResource('sport-catalog', () => pickup.listSports())
  return <CatalogContext.Provider value={catalog.state.status === 'ready' ? catalog.state.data : seededSports}>
    {catalog.state.status === 'error' && <LoadError error={catalog.state.error} retry={catalog.retry} />}
    {children}
  </CatalogContext.Provider>
}

export function useCatalog() { return useContext(CatalogContext) }

type PickerProps = { value: string; onChange: (value: string) => void; create?: boolean; label?: string }

export function SportPicker({ value, onChange, create = false, label = 'Sport' }: PickerProps) {
  const catalog = useCatalog()
  const list = useId()
  const [draft, setDraft] = useState('')
  const action = useAction()
  const selected = catalog.find(sport => sport.slug === value)
  const query = draft.trim()
  return <div className="form-stack">
    <label>{label}<input list={list} value={selected?.name ?? draft}
      placeholder={create ? 'Search or enter a sport' : 'Search sports'}
      onChange={event => {
        const input = event.target.value
        const match = catalog.find(sport => sport.name.toLowerCase() === input.trim().toLowerCase())
        setDraft(input)
        onChange(match?.slug ?? '')
      }}
    /></label>
    <datalist id={list}>{catalog.map(sport => <option key={sport.slug} value={sport.name} />)}</datalist>
    {create && !selected && query && <button type="button" className="button secondary self-start" disabled={action.pending}
      onClick={() => void action.run(async () => {
        const sport = await pickup.createSport(query)
        onChange(sport.slug)
      }, 'Sport selected.')}>Use custom sport</button>}
    <ActionNotice {...action} />
  </div>
}
