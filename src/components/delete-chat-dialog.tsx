/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { forwardRef, useImperativeHandle, useRef, useState } from 'react'

import { ConfirmActionDialog, type ConfirmActionDialogRef } from '@/components/ui/confirm-action-dialog'

export type DeleteChatDialogRef = ConfirmActionDialogRef

type DeleteChatDialogProps = {
  isPending?: boolean
  onCancel?: () => void
  /** Deletes the chat. For a chat synced with AI Potluck, this deletes it there too. */
  onConfirm: () => void
  /**
   * Whether the chat about to be deleted is synced with AI Potluck. Awaited when the dialog opens; when it resolves
   * true the prompt names both places and offers `onRemoveLocalOnly`. Absent or false: the plain prompt.
   */
  checkSynced?: () => Promise<boolean>
  /** Deletes the chat in Thunderbolt only, leaving it on AI Potluck. Offered only for a synced chat. */
  onRemoveLocalOnly?: () => void
}

export const DeleteChatDialog = forwardRef<DeleteChatDialogRef, DeleteChatDialogProps>(
  ({ isPending, onCancel, onConfirm, checkSynced, onRemoveLocalOnly }, ref) => {
    const { t } = useLingui()
    const [open, setOpen] = useState(false)
    const [synced, setSynced] = useState(false)
    // Each open() takes a ticket, so a slow check from an earlier open can't reopen or relabel a later one.
    const openTicket = useRef(0)

    useImperativeHandle(ref, () => ({
      open: () => {
        const ticket = ++openTicket.current
        if (!checkSynced) {
          setSynced(false)
          setOpen(true)
          return
        }
        // A failed check falls back to the plain prompt, which sends nothing to AI Potluck for a chat it pulled.
        checkSynced()
          .catch(() => false)
          .then((isSynced) => {
            if (ticket !== openTicket.current) {
              return
            }
            setSynced(isSynced)
            setOpen(true)
          })
      },
      close: () => {
        openTicket.current++
        setOpen(false)
      },
    }))

    const showSynced = synced && Boolean(onRemoveLocalOnly)

    return (
      <ConfirmActionDialog
        open={open}
        title={showSynced ? t`Delete this chat from Thunderbolt and AI Potluck?` : t`Delete this chat?`}
        description={
          showSynced
            ? t`This chat is synced with AI Potluck. Deleting it removes it from both. To keep it on AI Potluck, remove it from Thunderbolt only.`
            : t`This will permanently delete this chat.`
        }
        confirmLabel={showSynced ? t`Delete from Both` : t`Delete Chat`}
        secondaryLabel={showSynced ? t`Remove from Thunderbolt only` : undefined}
        onSecondary={showSynced ? onRemoveLocalOnly : undefined}
        isPending={isPending}
        onConfirm={onConfirm}
        onCancel={() => {
          openTicket.current++
          setOpen(false)
          onCancel?.()
        }}
      />
    )
  },
)

DeleteChatDialog.displayName = 'DeleteChatDialog'
