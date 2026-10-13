// Pure grouping, kept apart from the JSX so tests can import it.
export type Group<T> = { status: string; items: T[] };

// Items keep their order. Empty groups are dropped. An unknown status goes to the last group.
export function groupByStatus<T extends { status: string }>(items: T[], order: readonly string[]): Group<T>[] {
  const groups = order.map((status): Group<T> => ({ status, items: [] }));
  for (const item of items) {
    const group = groups.find((g) => g.status === item.status) ?? groups[groups.length - 1];
    group?.items.push(item);
  }
  return groups.filter((g) => g.items.length > 0);
}
