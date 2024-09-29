//
// Copyright © 2022 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import calendar, { Calendar, Event, ExternalCalendar } from '@hcengineering/calendar'
import contactPlugin, { Contact, Person, PersonAccount } from '@hcengineering/contact'
import core, {
  Class,
  Data,
  Doc,
  DocumentQuery,
  FindOptions,
  FindResult,
  Hierarchy,
  Ref,
  Tx,
  TxCreateDoc,
  TxCUD,
  TxProcessor,
  TxRemoveDoc,
  TxUpdateDoc
} from '@hcengineering/core'
import { getResource } from '@hcengineering/platform'
import { TriggerControl } from '@hcengineering/server-core'
import { getHTMLPresenter, getTextPresenter } from '@hcengineering/server-notification-resources'

/**
 * @public
 */
export async function FindReminders (
  doc: Doc,
  hiearachy: Hierarchy,
  findAll: <T extends Doc>(
    clazz: Ref<Class<T>>,
    query: DocumentQuery<T>,
    options?: FindOptions<T>
  ) => Promise<FindResult<T>>
): Promise<Doc[]> {
  const events = await findAll(calendar.class.Event, { attachedTo: doc._id })
  return events
}

/**
 * @public
 */
export async function ReminderHTMLPresenter (doc: Doc, control: TriggerControl): Promise<string | undefined> {
  const event = doc as Event
  const target = (await control.findAll(control.ctx, event.attachedToClass, { _id: event.attachedTo }, { limit: 1 }))[0]
  if (target !== undefined) {
    const HTMLPresenter = getHTMLPresenter(target._class, control.hierarchy)
    const htmlPart =
      HTMLPresenter !== undefined ? await (await getResource(HTMLPresenter.presenter))(target, control) : undefined
    return htmlPart
  }
}

/**
 * @public
 */
export async function ReminderTextPresenter (doc: Doc, control: TriggerControl): Promise<string | undefined> {
  const event = doc as Event
  const target = (await control.findAll(control.ctx, event.attachedToClass, { _id: event.attachedTo }, { limit: 1 }))[0]
  if (target !== undefined) {
    const TextPresenter = getTextPresenter(target._class, control.hierarchy)
    if (TextPresenter === undefined) return
    return await (
      await getResource(TextPresenter.presenter)
    )(target, control)
  }
}

/**
 * @public
 */
export async function OnPersonAccountCreate (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  const ctx = TxProcessor.extractTx(tx) as TxCreateDoc<PersonAccount>
  const user = TxProcessor.createDoc2Doc(ctx)

  const res: TxCreateDoc<Calendar> = control.txFactory.createTxCreateDoc(
    calendar.class.Calendar,
    calendar.space.Calendar,
    {
      name: user.email,
      hidden: false,
      visibility: 'public'
    },
    `${user._id}_calendar` as Ref<Calendar>,
    undefined,
    user._id
  )
  return [res]
}

function getCalendar (calendars: Calendar[], person: Ref<PersonAccount>): Ref<Calendar> | undefined {
  const filtered = calendars.filter((c) => (c.createdBy ?? c.modifiedBy) === person)
  const defaultExternal = filtered.find((c) => (c as ExternalCalendar).default)
  if (defaultExternal !== undefined) return defaultExternal._id
  return filtered[0]?._id
}

function getEventPerson (current: Event, calendars: Calendar[], control: TriggerControl): Ref<Contact> | undefined {
  const calendar = calendars.find((c) => c._id === current.calendar)
  if (calendar === undefined) return
  const accId = (current.createdBy ?? current.modifiedBy) as Ref<PersonAccount>
  const acc = control.modelDb.findAllSync(contactPlugin.class.PersonAccount, { _id: accId })[0]
  if (acc === undefined) return
  return acc.person
}

async function OnEvent (tx: Tx, control: TriggerControl): Promise<Tx[]> {
  const ctx = TxProcessor.extractTx(tx) as TxCUD<Event>
  if (ctx._class === core.class.TxCreateDoc) {
    return await onEventCreate(ctx as TxCreateDoc<Event>, control)
  } else if (ctx._class === core.class.TxUpdateDoc) {
    return await onEventUpdate(ctx as TxUpdateDoc<Event>, control)
  } else if (ctx._class === core.class.TxRemoveDoc) {
    return await onRemoveEvent(ctx as TxRemoveDoc<Event>, control)
  }

  return []
}

async function onEventUpdate (ctx: TxUpdateDoc<Event>, control: TriggerControl): Promise<Tx[]> {
  const ops = ctx.operations
  const { visibility, ...otherOps } = ops
  if (Object.keys(otherOps).length === 0) return []
  const event = (await control.findAll(control.ctx, calendar.class.Event, { _id: ctx.objectId }, { limit: 1 }))[0]
  if (event === undefined) return []
  if (event.access !== 'owner') return []
  const events = await control.findAll(control.ctx, calendar.class.Event, { eventId: event.eventId })
  const res: Tx[] = []
  const newParticipants = new Set<Ref<Contact>>(event.participants)
  const calendars = await control.findAll(control.ctx, calendar.class.Calendar, { hidden: false })
  for (const ev of events) {
    if (ev._id === event._id) continue
    const person = getEventPerson(ev, calendars, control)
    if (person === undefined || !event.participants.includes(person)) {
      const innerTx = control.txFactory.createTxRemoveDoc(ev._class, ev.space, ev._id)
      const outerTx = control.txFactory.createTxCollectionCUD(
        ev.attachedToClass,
        ev.attachedTo,
        ev.space,
        ev.collection,
        innerTx
      )
      res.push(outerTx)
    } else {
      newParticipants.delete(person)
      const innerTx = control.txFactory.createTxUpdateDoc(ev._class, ev.space, ev._id, { ...otherOps })
      const outerTx = control.txFactory.createTxCollectionCUD(
        ev.attachedToClass,
        ev.attachedTo,
        ev.space,
        ev.collection,
        innerTx
      )
      res.push(outerTx)
    }
  }
  if (newParticipants.size === 0) return res
  const newPartTxs = await eventForNewParticipants(event, newParticipants, calendars, control)
  return res.concat(newPartTxs)
}

async function eventForNewParticipants (
  event: Event,
  newParticipants: Set<Ref<Person>>,
  calendars: Calendar[],
  control: TriggerControl
): Promise<Tx[]> {
  const res: Tx[] = []
  const accounts = await control.findAll(control.ctx, contactPlugin.class.PersonAccount, {
    person: { $in: event.participants }
  })
  const access = 'reader'
  const { _class, space, attachedTo, attachedToClass, collection, ...attr } = event
  const data = attr as any as Data<Event>
  for (const part of newParticipants) {
    const acc = accounts.find((a) => a.person === part)
    if (acc === undefined) continue
    if (acc._id === (event.createdBy ?? event.modifiedBy)) continue
    const calendar = getCalendar(calendars, acc._id)
    if (calendar === undefined) continue
    const innerTx = control.txFactory.createTxCreateDoc(
      _class,
      space,
      { ...data, calendar, access },
      undefined,
      undefined,
      acc._id
    )
    const outerTx = control.txFactory.createTxCollectionCUD(
      attachedToClass,
      attachedTo,
      space,
      collection,
      innerTx,
      undefined,
      acc._id
    )
    res.push(outerTx)
  }
  return res
}

async function onEventCreate (ctx: TxCreateDoc<Event>, control: TriggerControl): Promise<Tx[]> {
  const event = TxProcessor.createDoc2Doc(ctx)
  if (event.access !== 'owner') return []
  const res: Tx[] = []
  const { _class, space, attachedTo, attachedToClass, collection, ...attr } = event
  const data = attr as any as Data<Event>
  const calendars = await control.findAll(control.ctx, calendar.class.Calendar, { hidden: false })
  const accounts = await control.findAll(control.ctx, contactPlugin.class.PersonAccount, {
    person: { $in: event.participants }
  })
  const access = 'reader'
  for (const part of event.participants) {
    const acc = accounts.find((a) => a.person === part)
    if (acc === undefined) continue
    if (acc._id === (event.createdBy ?? event.modifiedBy)) continue
    const calendar = getCalendar(calendars, acc._id)
    if (calendar === undefined) continue
    const innerTx = control.txFactory.createTxCreateDoc(
      _class,
      space,
      { ...data, calendar, access },
      undefined,
      undefined,
      acc._id
    )
    const outerTx = control.txFactory.createTxCollectionCUD(
      attachedToClass,
      attachedTo,
      space,
      collection,
      innerTx,
      undefined,
      acc._id
    )
    res.push(outerTx)
  }
  return res
}

async function onRemoveEvent (ctx: TxRemoveDoc<Event>, control: TriggerControl): Promise<Tx[]> {
  const removed = control.removedMap.get(ctx.objectId) as Event
  const res: Tx[] = []
  if (removed !== undefined) {
    if (removed.access !== 'owner') return []
    const current = await control.findAll(control.ctx, calendar.class.Event, { eventId: removed.eventId })
    for (const cur of current) {
      res.push(control.txFactory.createTxRemoveDoc(cur._class, cur.space, cur._id))
    }
  }
  return res
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export default async () => ({
  function: {
    ReminderHTMLPresenter,
    ReminderTextPresenter,
    FindReminders
  },
  trigger: {
    OnPersonAccountCreate,
    OnEvent
  }
})
