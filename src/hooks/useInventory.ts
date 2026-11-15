// Inventory hooks (WP6): re-query on 'inventory' | 'lists' | 'catalog'.
import type { InventoryRow, ListId, ListSummary } from '@/domain/types';
import { getItems, getLists } from '@/data/inventoryRepo';
import { useDbVersion } from '@/data/dbEvents';
import { useAsync, type AsyncState } from './useAsync';

export function useLists(): AsyncState<ListSummary[]> {
  const version = useDbVersion('inventory', 'lists', 'catalog');
  return useAsync(() => getLists(), [version]);
}

export function useInventory(listId: ListId | null): AsyncState<InventoryRow[]> {
  const version = useDbVersion('inventory', 'lists', 'catalog');
  return useAsync(() => getItems(listId), [listId, version]);
}
