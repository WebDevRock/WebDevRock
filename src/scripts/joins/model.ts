// The three physical join algorithms, as step-by-step events for the animation, plus a simple
// cost model for comparing them at real table sizes. The cost model is a teaching model with stated
// assumptions, not SQL Server's own costing.

export type Algorithm = 'loops' | 'hash' | 'merge';

// ---------- Small sample for the animation ----------
// Each order refers to one customer. Several orders can share a customer, as in real data.
export const SAMPLE_ORDERS = [3, 1, 4, 1, 5, 2, 6, 3];
// With an index on CustomerId (the clustered primary key), customers are stored in CustomerId order.
// Without one, as in a table loaded from a CSV file, they're in whatever order they arrived.
export const customerRow = (indexed: boolean) => (indexed ? [1, 2, 3, 4, 5, 6] : [4, 1, 6, 3, 5, 2]);
export const BUCKETS = 3;
export const bucketOf = (customerId: number) => customerId % BUCKETS;

export type Event =
  | { t: 'phase'; text: string }
  | { t: 'move'; id: string; to: Slot }
  | { t: 'compare'; a: string; b: string; match: boolean }
  | { t: 'output'; order: string; customer: string };

// Where a block should go, in the lane's own layout
export type Slot =
  | { area: 'orders'; index: number }
  | { area: 'customers'; index: number }
  | { area: 'probe' }
  | { area: 'bucket'; bucket: number; level: number }
  | { area: 'bucket-front'; bucket: number }
  | { area: 'output'; index: number };

const oid = (k: number) => `o${k}`;
const cid = (j: number) => `c${j}`;

/** Nested loops: for each order, find its customer, with an index seek or by checking every customer */
export function* nestedLoops(index: boolean): Generator<Event> {
  const customers = customerRow(index);
  yield { t: 'phase', text: index ? 'For each order, seek its customer in the index' : 'No index: for each order, check every customer' };
  for (let k = 0; k < SAMPLE_ORDERS.length; k++) {
    yield { t: 'move', id: oid(k), to: { area: 'probe' } };
    const want = SAMPLE_ORDERS[k];
    let found = -1;
    if (index) {
      found = customers.indexOf(want);
      yield { t: 'compare', a: oid(k), b: cid(found), match: true };
    } else {
      // Without an index nothing says where the customer is, so every customer is checked
      for (let j = 0; j < customers.length; j++) {
        const match = customers[j] === want;
        if (match) found = j;
        yield { t: 'compare', a: oid(k), b: cid(j), match };
      }
    }
    yield { t: 'output', order: oid(k), customer: cid(found) };
  }
}

/** Hash: build a hash table from customers, then probe it with each order */
export function* hashJoin(index: boolean): Generator<Event> {
  const customers = customerRow(index);
  yield { t: 'phase', text: 'Build: put each customer in a bucket by its CustomerId' };
  const levels = new Array(BUCKETS).fill(0);
  const bucketContents: number[][] = Array.from({ length: BUCKETS }, () => []);
  for (let j = 0; j < customers.length; j++) {
    const b = bucketOf(customers[j]);
    yield { t: 'move', id: cid(j), to: { area: 'bucket', bucket: b, level: levels[b]++ } };
    bucketContents[b].push(j);
  }
  yield { t: 'phase', text: 'Probe: each order checks only its own bucket' };
  for (let k = 0; k < SAMPLE_ORDERS.length; k++) {
    const b = bucketOf(SAMPLE_ORDERS[k]);
    yield { t: 'move', id: oid(k), to: { area: 'bucket-front', bucket: b } };
    let found = -1;
    for (const j of bucketContents[b]) {
      const match = customers[j] === SAMPLE_ORDERS[k];
      if (match) found = j;
      yield { t: 'compare', a: oid(k), b: cid(j), match };
    }
    yield { t: 'output', order: oid(k), customer: cid(found) };
  }
}

/** Insertion sort of one row of blocks, showing every comparison and swap. Returns the new order. */
function* sortRow(values: number[], id: (k: number) => string, area: 'orders' | 'customers'): Generator<Event, number[]> {
  const row = values.map((_, k) => k);
  for (let p = 1; p < row.length; p++) {
    let q = p;
    while (q > 0) {
      const left = row[q - 1];
      const right = row[q];
      yield { t: 'compare', a: id(left), b: id(right), match: false };
      if (values[left] <= values[right]) break;
      row[q - 1] = right;
      row[q] = left;
      yield { t: 'move', id: id(right), to: { area, index: q - 1 } };
      yield { t: 'move', id: id(left), to: { area, index: q } };
      q--;
    }
  }
  return row;
}

/** Merge: sort either input by CustomerId if needed, then walk both sorted lists together */
export function* mergeJoin(ordersSorted: boolean, index: boolean): Generator<Event> {
  const customers = customerRow(index);
  let orderRow = SAMPLE_ORDERS.map((_, k) => k);
  if (ordersSorted) {
    // An index on Orders(CustomerId) hands the rows over already in order
    orderRow.sort((a, b) => SAMPLE_ORDERS[a] - SAMPLE_ORDERS[b]);
    for (let p = 0; p < orderRow.length; p++) yield { t: 'move', id: oid(orderRow[p]), to: { area: 'orders', index: p } };
  } else {
    yield { t: 'phase', text: 'Sort the orders by CustomerId first' };
    orderRow = yield* sortRow(SAMPLE_ORDERS, oid, 'orders');
  }
  let customerOrder = customers.map((_, j) => j);
  if (!index) {
    yield { t: 'phase', text: 'No index: sort the customers by CustomerId too' };
    customerOrder = yield* sortRow(customers, cid, 'customers');
  }
  yield { t: 'phase', text: 'Merge: step through both sorted lists together' };
  let i = 0;
  let j = 0;
  while (i < orderRow.length && j < customerOrder.length) {
    const o = SAMPLE_ORDERS[orderRow[i]];
    const c = customers[customerOrder[j]];
    yield { t: 'compare', a: oid(orderRow[i]), b: cid(customerOrder[j]), match: o === c };
    if (o === c) {
      yield { t: 'output', order: oid(orderRow[i]), customer: cid(customerOrder[j]) };
      i++; // the next order may belong to the same customer, so the customer pointer stays
    } else if (o < c) {
      i++;
    } else {
      j++;
    }
  }
}

// ---------- Cost model at real sizes ----------
export interface Sizes {
  orders: number;
  customers: number;
  customerIndex: boolean;
  ordersSorted: boolean;
}

export interface Estimate {
  algorithm: Algorithm;
  pagesRead: number;
  comparisons: number;
  memoryKb: number;
  work: number;
}

// Assumptions, stated in the article: rows per 8 KB page, pointers per index page, bytes per hash table row
export const ORDERS_PER_PAGE = 50;
export const CUSTOMERS_PER_PAGE = 30;
export const FAN_OUT = 500;
export const ROW_BYTES = 40;

export const pagesFor = (rows: number, perPage: number) => Math.max(1, Math.ceil(rows / perPage));
export const indexDepth = (pages: number) => (pages <= 1 ? 1 : 1 + Math.ceil(Math.log(pages) / Math.log(FAN_OUT)));

// Work combines the three: a page read counts as 1, a thousand row comparisons as 1, and 100 KB of memory as 1
export const workOf = (pagesRead: number, comparisons: number, memoryKb: number) => pagesRead + comparisons / 1000 + memoryKb / 100;

export function estimate(s: Sizes): Estimate[] {
  const oPages = pagesFor(s.orders, ORDERS_PER_PAGE);
  const cPages = pagesFor(s.customers, CUSTOMERS_PER_PAGE);
  const both = oPages + cPages;

  // Nested loops: read the orders once, then one lookup per order
  const seekPages = indexDepth(cPages);
  const loops = s.customerIndex
    ? { pagesRead: oPages + s.orders * seekPages, comparisons: s.orders * seekPages, memoryKb: 0 }
    : { pagesRead: oPages + s.orders * cPages, comparisons: s.orders * s.customers, memoryKb: 0 };

  // Hash: read both once; build the hash table from the smaller input, probe with the larger
  const build = Math.min(s.orders, s.customers);
  const hash = { pagesRead: both, comparisons: s.orders + s.customers, memoryKb: (build * ROW_BYTES) / 1024 };

  // Merge: read both once, in CustomerId order. Customers come sorted from their clustered primary key
  // (when there's no index, they need sorting too), and orders need sorting unless an index on
  // Orders(CustomerId) supplies them in order. Sorting n rows takes about n × log2(n) comparisons.
  const sortCost = (n: number) => (n < 2 ? 0 : n * Math.log2(n));
  const sortOrders = !s.ordersSorted;
  const sortCustomers = !s.customerIndex;
  const merge = {
    pagesRead: both,
    comparisons: s.orders + s.customers + (sortOrders ? sortCost(s.orders) : 0) + (sortCustomers ? sortCost(s.customers) : 0),
    memoryKb: (((sortOrders ? s.orders : 0) + (sortCustomers ? s.customers : 0)) * ROW_BYTES) / 1024,
  };

  return (
    [
      ['loops', loops],
      ['hash', hash],
      ['merge', merge],
    ] as const
  ).map(([algorithm, e]) => ({ algorithm, ...e, work: workOf(e.pagesRead, e.comparisons, e.memoryKb) }));
}

export const SCENARIOS: { id: string; title: string; story: string; sizes: Sizes }[] = [
  {
    id: 'one',
    title: 'One customer’s orders',
    story: 'The “My orders” page: 12 orders for one customer, each joined to the customer’s details. The Customers table has 20,000 rows and its primary key, CustomerId, is indexed.',
    sizes: { orders: 12, customers: 20000, customerIndex: true, ordersSorted: false },
  },
  {
    id: 'report',
    title: 'Monthly sales report',
    story: 'October’s 31,204 orders joined to 20,000 customers to total revenue by city. The orders come from scanning the table, in no particular CustomerId order.',
    sizes: { orders: 31204, customers: 20000, customerIndex: true, ordersSorted: false },
  },
  {
    id: 'sorted',
    title: 'Report with an index on Orders(CustomerId)',
    story: 'The same report after adding an index on Orders(CustomerId). The orders can now be read already in CustomerId order, the same order as the Customers table.',
    sizes: { orders: 31204, customers: 20000, customerIndex: true, ordersSorted: true },
  },
  {
    id: 'noindex',
    title: 'Joining to an imported table',
    story: 'The same 12 orders, joined to a 20,000-row customer list loaded from a CSV file into a table with no indexes. There’s no quick way to find a customer, and the rows are in no particular order.',
    sizes: { orders: 12, customers: 20000, customerIndex: false, ordersSorted: false },
  },
];

export const NAMES: Record<Algorithm, string> = { loops: 'Nested loops', hash: 'Hash match', merge: 'Merge join' };
