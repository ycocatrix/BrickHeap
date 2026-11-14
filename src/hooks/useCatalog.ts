// Catalogue hooks (§4.7): re-read whenever the 'catalog' topic is notified.
import { useEffect, useState } from 'react';
import type { CatalogPart, ColorId, Palette, PartDetail, PartId } from '@/domain/types';
import { err } from '@/domain/result';
import { useDbVersion } from '@/data/dbEvents';
import { getPalette, getPart, getPartDetail, peekPalette } from '@/services/catalog';
import { part as partText } from '@/i18n/fr/part';
import { useAsync, useAsyncResult, type AsyncState } from './useAsync';

/** null only during the first load. */
export function usePalette(): Palette | null {
  const version = useDbVersion('catalog');
  const [palette, setPalette] = useState<Palette | null>(() => peekPalette());
  useEffect(() => {
    let live = true;
    void getPalette().then((p) => {
      if (live) setPalette(p);
    });
    return () => {
      live = false;
    };
  }, [version]);
  return palette;
}

/** Local catalogue row of a part; re-reads on 'catalog'. */
export function usePart(partId: PartId | null): AsyncState<CatalogPart | null> {
  const version = useDbVersion('catalog');
  return useAsync(() => (partId ? getPart(partId) : Promise.resolve(null)), [partId, version]);
}

/** First page of the fiche detail (part+colour info and sets). Not re-run on 'catalog' (the call itself notifies). */
export function usePartDetail(partId: PartId | null, colorId: ColorId | null): AsyncState<PartDetail> {
  return useAsyncResult(
    () => (partId && colorId !== null ? getPartDetail(partId, colorId, 1) : Promise.resolve(err('invalid', partText.sets.chooseColor))),
    [partId, colorId],
  );
}
