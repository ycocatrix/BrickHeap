import type { ColorId, ItemRef, PartId } from './types';

export function itemKey(partId: PartId, colorId: ColorId): string {
  return `${partId}|${colorId}`;
}

export function parseItemKey(key: string): { partId: PartId; colorId: ColorId } | null {
  const i = key.lastIndexOf('|');
  if (i <= 0) return null;
  const colorPart = key.slice(i + 1);
  if (!/^-?\d+$/.test(colorPart)) return null;
  return { partId: key.slice(0, i), colorId: Number(colorPart) };
}

export function sameRef(a: ItemRef, b: ItemRef): boolean {
  return a.listId === b.listId && a.partId === b.partId && a.colorId === b.colorId;
}
