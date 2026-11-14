// Shared undo / error feedback for inventory edits (RG_09 / EX_16). Callers close their sheet BEFORE calling these
// (Snackbar rule, §3).
import type { AppliedDeltas, ItemRef, ListId } from '@/domain/types';
import { applyDeltas, moveItem, setQuantity } from '@/data/inventoryRepo';
import { showSnackbar, UNDO_MS } from '@/components/Snackbar';
import { feedback } from '@/services/feedback';
import { common } from '@/i18n/fr/common';
import { tpl } from '@/i18n/format';
import { inventory as t } from '@/i18n/fr/inventory';

/** Time for an RN Modal sheet to finish closing before another one opens or an Alert is shown (iOS refuses to
 *  present while a modal is dismissing). */
export const SHEET_SWAP_MS = 350;

function failed(): void {
  feedback.error();
  showSnackbar({ text: t.actions.failed });
}

function undoSnackbar(applied: AppliedDeltas, text: string): void {
  if (applied.applied.length === 0) return;
  showSnackbar({
    text,
    actionLabel: common.actions.undo,
    durationMs: UNDO_MS,
    onAction: async () => {
      try {
        await applyDeltas(applied.inverse);
        feedback.success();
        showSnackbar({ text: t.actions.restored });
      } catch {
        failed();
      }
    },
  });
}

/** setQuantity(ref, 0) + undo snackbar (« Supprimer » and stepper to 0). */
export async function removeWithUndo(ref: ItemRef, name: string): Promise<void> {
  try {
    const applied = await setQuantity(ref, 0);
    feedback.success();
    undoSnackbar(applied, tpl(t.actions.removed, { name }));
  } catch {
    failed();
  }
}

/** Quantity edit from the stepper (no snackbar unless it fails). */
export async function changeQuantity(ref: ItemRef, quantity: number): Promise<void> {
  try {
    await setQuantity(ref, quantity);
  } catch {
    failed();
  }
}

/** moveItem + undo snackbar. */
export async function moveWithUndo(ref: ItemRef, toListId: ListId, name: string, listName: string): Promise<void> {
  try {
    const applied = await moveItem(ref, toListId);
    feedback.success();
    undoSnackbar(applied, tpl(t.actions.moved, { name, list: listName }));
  } catch {
    failed();
  }
}
