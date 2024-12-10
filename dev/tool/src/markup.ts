//
// Copyright © 2024 Hardcore Engineering Inc.
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

import { loadCollabYdoc, saveCollabYdoc, yDocCopyXmlField } from '@hcengineering/collaboration'
import core, {
  type Blob,
  type Doc,
  type MeasureContext,
  type Ref,
  type TxCreateDoc,
  type WorkspaceId,
  DOMAIN_TX,
  makeCollabYdocId,
  makeDocCollabId
} from '@hcengineering/core'
import document, { type Document } from '@hcengineering/document'
import documents from '@hcengineering/controlled-documents'
import { DOMAIN_DOCUMENT } from '@hcengineering/model-document'
import { DOMAIN_DOCUMENTS } from '@hcengineering/model-controlled-documents'
import { type StorageAdapter } from '@hcengineering/server-core'
import { type Db } from 'mongodb'

export interface RestoreWikiContentParams {
  dryRun: boolean
}

export async function restoreWikiContentMongo (
  ctx: MeasureContext,
  db: Db,
  workspaceId: WorkspaceId,
  storageAdapter: StorageAdapter,
  params: RestoreWikiContentParams
): Promise<void> {
  const iterator = db.collection<Document>(DOMAIN_DOCUMENT).find({ _class: document.class.Document })

  let processedCnt = 0
  let restoredCnt = 0

  function printStats (): void {
    console.log('...processed', processedCnt, 'restored', restoredCnt)
  }

  try {
    while (true) {
      const doc = await iterator.next()
      if (doc === null) break

      processedCnt++
      if (processedCnt % 100 === 0) {
        printStats()
      }

      const correctCollabId = { objectClass: doc._class, objectId: doc._id, objectAttr: 'content' }
      const wrongCollabId = { objectClass: doc._class, objectId: doc._id, objectAttr: 'description' }

      const stat = storageAdapter.stat(ctx, workspaceId, makeCollabYdocId(wrongCollabId))
      if (stat === undefined) continue

      const ydoc1 = await loadCollabYdoc(ctx, storageAdapter, workspaceId, correctCollabId)
      const ydoc2 = await loadCollabYdoc(ctx, storageAdapter, workspaceId, wrongCollabId)

      if (ydoc1 !== undefined && ydoc1.share.has('content')) {
        // There already is content, we should skip the document
        continue
      }

      if (ydoc2 === undefined) {
        // There are no content to restore
        continue
      }

      try {
        console.log('restoring content for', doc._id)
        if (!params.dryRun) {
          if (ydoc2.share.has('description') && !ydoc2.share.has('content')) {
            yDocCopyXmlField(ydoc2, 'description', 'content')
          }

          await saveCollabYdoc(ctx, storageAdapter, workspaceId, correctCollabId, ydoc2)
        }
        restoredCnt++
      } catch (err: any) {
        console.error('failed to restore content for', doc._id, err)
      }
    }
  } finally {
    printStats()
    await iterator.close()
  }
}

export interface RestoreControlledDocContentParams {
  dryRun: boolean
}

export async function restoreControlledDocContentMongo (
  ctx: MeasureContext,
  db: Db,
  workspaceId: WorkspaceId,
  storageAdapter: StorageAdapter,
  params: RestoreWikiContentParams
): Promise<void> {
  const iterator = db.collection<Doc>(DOMAIN_DOCUMENTS).find({
    _class: {
      $in: [
        documents.class.ControlledDocument,
        documents.class.ControlledDocumentSnapshot
      ]
    }
  })

  let processedCnt = 0
  let restoredCnt = 0

  function printStats (): void {
    console.log('...processed', processedCnt, 'restored', restoredCnt)
  }

  try {
    while (true) {
      const doc = await iterator.next()
      if (doc === null) break

      const restored = await restoreControlledDocContentForDoc(ctx, db, workspaceId, storageAdapter, params, doc, 'content')
      if (restored) {
        restoredCnt++
      }

      processedCnt++
      if (processedCnt % 100 === 0) {
        printStats()
      }
    }
  } finally {
    printStats()
    await iterator.close()
  }
}

export async function restoreControlledDocContentForDoc (
  ctx: MeasureContext,
  db: Db,
  workspaceId: WorkspaceId,
  storageAdapter: StorageAdapter,
  params: RestoreWikiContentParams,
  doc: Doc,
  attribute: string
): Promise<boolean> {
  const tx = await db.collection<TxCreateDoc<Doc>>(DOMAIN_TX).findOne({
    _class: core.class.TxCreateDoc,
    objectId: doc._id,
    objectClass: doc._class
  })

  // It is expected that tx contains attribute with content in old collaborative doc format
  // the original value here looks like '65b7f82f4d422b89d4cbdd6f:HEAD:0'
  const attribures = tx?.attributes ?? {}
  const value = (attribures as any)[attribute] as string
  if (value == null || !value.includes(':')) {
    console.log('no content to restore', doc._class, doc._id)
    return false
  }

  const currentYdocId = value.split(':')[0] as Ref<Blob>
  const ydocId = makeCollabYdocId(makeDocCollabId(doc, attribute))

  // Ensure that we don't have new content in storage
  const stat = await storageAdapter.stat(ctx, workspaceId, ydocId)
  if (stat !== undefined) {
    console.log('content already restored', doc._class, doc._id, ydocId)
    return false
  }

  console.log('restoring content', doc._id, currentYdocId, '-->', ydocId)
  if (!params.dryRun) {
    try {
      const stat = await storageAdapter.stat(ctx, workspaceId, currentYdocId)
      if (stat === undefined) {
        console.log('no content to restore', doc._class, doc._id, ydocId)
        return false
      }

      const buffer = await storageAdapter.read(ctx, workspaceId, currentYdocId)
      await storageAdapter.put(
        ctx,
        workspaceId,
        ydocId,
        Buffer.concat(buffer as any),
        'application/ydoc',
        buffer.length
      )
    } catch (err: any) {
      console.error('failed to restore content for', doc._class, doc._id, err)
      return false
    }
  }

  return true
}
