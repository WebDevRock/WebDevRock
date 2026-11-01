// Sample execution plans for a small "Shop" database: dbo.Orders (250,000 rows) and dbo.Customers (20,000 rows).
// They follow SQL Server's showplan XML format, trimmed to the parts the visualiser reads, with consistent costs.

export interface SamplePlan {
  id: string;
  title: string;
  story: string;
  xml: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const wrap = (stmt: string) =>
  `<?xml version="1.0" encoding="utf-16"?><ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.564" Build="16.0.4135.4"><BatchSequence><Batch><Statements>${stmt}</Statements></Batch></BatchSequence></ShowPlanXML>`;

const stmt = (text: string, cost: number, rows: number, body: string, optm = 'FULL') =>
  `<StmtSimple StatementText="${esc(text)}" StatementId="1" StatementCompId="1" StatementType="SELECT" StatementSubTreeCost="${cost}" StatementEstRows="${rows}" StatementOptmLevel="${optm}" CardinalityEstimationModelVersion="160">${body}</StmtSimple>`;

const col = (table: string, column: string, alias?: string) =>
  `<ColumnReference Database="[Shop]" Schema="[dbo]" Table="[${table}]"${alias ? ` Alias="[${alias}]"` : ''} Column="${column}" />`;
const exprCol = (column: string) => `<ColumnReference Column="${column}" />`;
const outputs = (...cols: string[]) => `<OutputList>${cols.join('')}</OutputList>`;
const runtime = (rows: number, executions = 1, rowsRead?: number) =>
  `<RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="${rows}"${rowsRead !== undefined ? ` ActualRowsRead="${rowsRead}"` : ''} Batches="0" ActualEndOfScans="${executions}" ActualExecutions="${executions}" ActualExecutionMode="Row" /></RunTimeInformation>`;
const object = (table: string, index: string, kind: 'Clustered' | 'NonClustered', alias?: string) =>
  `<Object Database="[Shop]" Schema="[dbo]" Table="[${table}]" Index="[${index}]"${alias ? ` Alias="[${alias}]"` : ''} IndexKind="${kind}" Storage="RowStore" />`;
const scalar = (s: string) => `<ScalarOperator ScalarString="${esc(s)}" />`;
const seekEq = (table: string, column: string, value: string) =>
  `<SeekPredicates><SeekPredicateNew><SeekKeys><Prefix ScanType="EQ"><RangeColumns>${col(table, column)}</RangeColumns><RangeExpressions>${scalar(value)}</RangeExpressions></Prefix></SeekKeys></SeekPredicateNew></SeekPredicates>`;

const relop = (a: Record<string, string | number>, inner: string) =>
  `<RelOp ${Object.entries(a)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')} Parallel="0" EstimatedExecutionMode="Row">${inner}</RelOp>`;

// 1. No index on CustomerId: read the whole table
const SCAN = wrap(
  stmt(
    'SELECT OrderId, OrderDate, Total FROM dbo.Orders WHERE CustomerId = 1027',
    2.13125,
    12.5,
    `<QueryPlan DegreeOfParallelism="1" CachedPlanSize="24" CompileTime="1" CompileCPU="1" CompileMemory="216">
      <MissingIndexes><MissingIndexGroup Impact="98.85"><MissingIndex Database="[Shop]" Schema="[dbo]" Table="[Orders]">
        <ColumnGroup Usage="EQUALITY"><Column Name="[CustomerId]" ColumnId="2" /></ColumnGroup>
        <ColumnGroup Usage="INCLUDE"><Column Name="[OrderDate]" ColumnId="3" /><Column Name="[Total]" ColumnId="4" /></ColumnGroup>
      </MissingIndex></MissingIndexGroup></MissingIndexes>
      ${relop(
        { NodeId: 0, PhysicalOp: 'Clustered Index Scan', LogicalOp: 'Clustered Index Scan', EstimateRows: 12.5, EstimatedRowsRead: 250000, EstimateIO: 1.85609, EstimateCPU: 0.275157, AvgRowSize: 27, EstimatedTotalSubtreeCost: 2.13125, TableCardinality: 250000, EstimateRebinds: 0, EstimateRewinds: 0 },
        `${outputs(col('Orders', 'OrderId'), col('Orders', 'OrderDate'), col('Orders', 'Total'))}${runtime(11, 1, 250000)}
        <IndexScan Ordered="0" ForcedIndex="0" ForceScan="0" NoExpandHint="0" Storage="RowStore">${object('Orders', 'PK_Orders', 'Clustered')}
          <Predicate>${scalar('[Shop].[dbo].[Orders].[CustomerId]=(1027)')}</Predicate></IndexScan>`
      )}
    </QueryPlan>`
  )
);

// 2. Index on CustomerId: seek, then a Key Lookup per row for OrderDate and Total
const LOOKUP = wrap(
  stmt(
    'SELECT OrderId, OrderDate, Total FROM dbo.Orders WHERE CustomerId = 1027',
    0.0398193,
    12.5,
    `<QueryPlan DegreeOfParallelism="1" CachedPlanSize="32" CompileTime="1" CompileCPU="1" CompileMemory="280">
      ${relop(
        { NodeId: 0, PhysicalOp: 'Nested Loops', LogicalOp: 'Inner Join', EstimateRows: 12.5, EstimateIO: 0, EstimateCPU: 5.225e-5, AvgRowSize: 27, EstimatedTotalSubtreeCost: 0.0398193, EstimateRebinds: 0, EstimateRewinds: 0 },
        `${outputs(col('Orders', 'OrderId'), col('Orders', 'OrderDate'), col('Orders', 'Total'))}${runtime(11)}
        <NestedLoops Optimized="0"><OuterReferences>${col('Orders', 'OrderId')}</OuterReferences>
        ${relop(
          { NodeId: 1, PhysicalOp: 'Index Seek', LogicalOp: 'Index Seek', EstimateRows: 12.5, EstimatedRowsRead: 12.5, EstimateIO: 0.003125, EstimateCPU: 0.0001707, AvgRowSize: 11, EstimatedTotalSubtreeCost: 0.0032957, TableCardinality: 250000, EstimateRebinds: 0, EstimateRewinds: 0 },
          `${outputs(col('Orders', 'OrderId'))}${runtime(11, 1, 11)}
          <IndexScan Ordered="1" ScanDirection="FORWARD" ForcedIndex="0" ForceSeek="0" ForceScan="0" NoExpandHint="0" Storage="RowStore">${object('Orders', 'IX_Orders_CustomerId', 'NonClustered')}
            ${seekEq('Orders', 'CustomerId', '(1027)')}</IndexScan>`
        )}
        ${relop(
          { NodeId: 3, PhysicalOp: 'Clustered Index Seek', LogicalOp: 'Clustered Index Seek', EstimateRows: 1, EstimateIO: 0.003125, EstimateCPU: 0.0001581, AvgRowSize: 23, EstimatedTotalSubtreeCost: 0.0364713, TableCardinality: 250000, EstimateRebinds: 11.5, EstimateRewinds: 0 },
          `${outputs(col('Orders', 'OrderDate'), col('Orders', 'Total'))}${runtime(11, 11, 11)}
          <IndexScan Lookup="1" Ordered="1" ScanDirection="FORWARD" ForcedIndex="0" ForceSeek="0" ForceScan="0" NoExpandHint="0" Storage="RowStore">${object('Orders', 'PK_Orders', 'Clustered')}
            ${seekEq('Orders', 'OrderId', '[Shop].[dbo].[Orders].[OrderId]')}</IndexScan>`
        )}
        </NestedLoops>`
      )}
    </QueryPlan>`
  )
);

// 3. Covering index: one seek, no lookups
const COVERING = wrap(
  stmt(
    'SELECT OrderId, OrderDate, Total FROM dbo.Orders WHERE CustomerId = 1027',
    0.0032957,
    12.5,
    `<QueryPlan DegreeOfParallelism="1" CachedPlanSize="24" CompileTime="0" CompileCPU="0" CompileMemory="200">
      ${relop(
        { NodeId: 0, PhysicalOp: 'Index Seek', LogicalOp: 'Index Seek', EstimateRows: 12.5, EstimatedRowsRead: 12.5, EstimateIO: 0.003125, EstimateCPU: 0.0001707, AvgRowSize: 27, EstimatedTotalSubtreeCost: 0.0032957, TableCardinality: 250000, EstimateRebinds: 0, EstimateRewinds: 0 },
        `${outputs(col('Orders', 'OrderId'), col('Orders', 'OrderDate'), col('Orders', 'Total'))}${runtime(11, 1, 11)}
        <IndexScan Ordered="1" ScanDirection="FORWARD" ForcedIndex="0" ForceSeek="0" ForceScan="0" NoExpandHint="0" Storage="RowStore">${object('Orders', 'IX_Orders_CustomerId', 'NonClustered')}
          ${seekEq('Orders', 'CustomerId', '(1027)')}</IndexScan>`
      )}
    </QueryPlan>`
  )
);

// 4. Monthly report: stale statistics underestimate October's orders, and the hash join spills
const REPORT_SQL = `SELECT c.City, COUNT(*) AS Orders, SUM(o.Total) AS Revenue
FROM dbo.Orders AS o
JOIN dbo.Customers AS c ON c.CustomerId = o.CustomerId
WHERE o.OrderDate >= '20261001' AND o.OrderDate < '20261101'
GROUP BY c.City
ORDER BY Revenue DESC`;

const REPORT = wrap(
  stmt(
    REPORT_SQL,
    3.0841,
    142,
    `<QueryPlan DegreeOfParallelism="1" MemoryGrant="2560" CachedPlanSize="48" CompileTime="4" CompileCPU="4" CompileMemory="560">
      <MissingIndexes><MissingIndexGroup Impact="68.4"><MissingIndex Database="[Shop]" Schema="[dbo]" Table="[Orders]">
        <ColumnGroup Usage="INEQUALITY"><Column Name="[OrderDate]" ColumnId="3" /></ColumnGroup>
        <ColumnGroup Usage="INCLUDE"><Column Name="[CustomerId]" ColumnId="2" /><Column Name="[Total]" ColumnId="4" /></ColumnGroup>
      </MissingIndex></MissingIndexGroup></MissingIndexes>
      <MemoryGrantInfo SerialRequiredMemory="1024" SerialDesiredMemory="2560" RequiredMemory="1024" DesiredMemory="2560" RequestedMemory="2560" GrantWaitTime="0" GrantedMemory="2560" MaxUsedMemory="2560" MaxQueryMemory="1600000" />
      ${relop(
        { NodeId: 0, PhysicalOp: 'Sort', LogicalOp: 'Sort', EstimateRows: 142, EstimateIO: 0.0112613, EstimateCPU: 0.0016165, AvgRowSize: 40, EstimatedTotalSubtreeCost: 3.0841, EstimateRebinds: 0, EstimateRewinds: 0 },
        `${outputs(col('Customers', 'City', 'c'), exprCol('Expr1002'), exprCol('Expr1003'))}${runtime(142)}
        <Sort Distinct="0"><OrderBy><OrderByColumn Ascending="0">${exprCol('Expr1003')}</OrderByColumn></OrderBy>
        ${relop(
          { NodeId: 1, PhysicalOp: 'Compute Scalar', LogicalOp: 'Compute Scalar', EstimateRows: 142, EstimateIO: 0, EstimateCPU: 1.42e-5, AvgRowSize: 40, EstimatedTotalSubtreeCost: 3.0712222, EstimateRebinds: 0, EstimateRewinds: 0 },
          `${outputs(col('Customers', 'City', 'c'), exprCol('Expr1002'), exprCol('Expr1003'))}${runtime(142)}
          <ComputeScalar><DefinedValues />${relop(
              { NodeId: 2, PhysicalOp: 'Hash Match', LogicalOp: 'Aggregate', EstimateRows: 142, EstimateIO: 0, EstimateCPU: 0.4517078, AvgRowSize: 40, EstimatedTotalSubtreeCost: 3.071208, EstimateRebinds: 0, EstimateRewinds: 0 },
              `${outputs(col('Customers', 'City', 'c'), exprCol('Expr1002'), exprCol('Expr1003'))}${runtime(142)}
              <Hash><DefinedValues /><HashKeysBuild>${col('Customers', 'City', 'c')}</HashKeysBuild>
              ${relop(
                { NodeId: 3, PhysicalOp: 'Hash Match', LogicalOp: 'Inner Join', EstimateRows: 8000, EstimateIO: 0, EstimateCPU: 0.3040002, AvgRowSize: 30, EstimatedTotalSubtreeCost: 2.6195002, EstimateRebinds: 0, EstimateRewinds: 0 },
                `${outputs(col('Customers', 'City', 'c'), col('Orders', 'Total', 'o'))}
                <Warnings><SpillToTempDb SpillLevel="1" SpilledThreadCount="1" /><HashSpillDetails GrantedMemoryKb="2560" UsedMemoryKb="2560" WritesToTempDb="410" ReadsFromTempDb="410" /></Warnings>
                ${runtime(31204)}
                <Hash><DefinedValues /><HashKeysBuild>${col('Orders', 'CustomerId', 'o')}</HashKeysBuild><HashKeysProbe>${col('Customers', 'CustomerId', 'c')}</HashKeysProbe>
                ${relop(
                  { NodeId: 4, PhysicalOp: 'Clustered Index Scan', LogicalOp: 'Clustered Index Scan', EstimateRows: 8000, EstimatedRowsRead: 250000, EstimateIO: 1.85609, EstimateCPU: 0.275157, AvgRowSize: 23, EstimatedTotalSubtreeCost: 2.13125, TableCardinality: 250000, EstimateRebinds: 0, EstimateRewinds: 0 },
                  `${outputs(col('Orders', 'CustomerId', 'o'), col('Orders', 'Total', 'o'))}${runtime(31204, 1, 250000)}
                  <IndexScan Ordered="0" ForcedIndex="0" ForceScan="0" NoExpandHint="0" Storage="RowStore">${object('Orders', 'PK_Orders', 'Clustered', 'o')}
                    <Predicate>${scalar("[Shop].[dbo].[Orders].[OrderDate] as [o].[OrderDate]>='2026-10-01 00:00:00.000' AND [Shop].[dbo].[Orders].[OrderDate] as [o].[OrderDate]<'2026-11-01 00:00:00.000'")}</Predicate></IndexScan>`
                )}
                ${relop(
                  { NodeId: 5, PhysicalOp: 'Clustered Index Scan', LogicalOp: 'Clustered Index Scan', EstimateRows: 20000, EstimatedRowsRead: 20000, EstimateIO: 0.1620602, EstimateCPU: 0.0221598, AvgRowSize: 21, EstimatedTotalSubtreeCost: 0.18425, TableCardinality: 20000, EstimateRebinds: 0, EstimateRewinds: 0 },
                  `${outputs(col('Customers', 'CustomerId', 'c'), col('Customers', 'City', 'c'))}${runtime(20000, 1, 20000)}
                  <IndexScan Ordered="0" ForcedIndex="0" ForceScan="0" NoExpandHint="0" Storage="RowStore">${object('Customers', 'PK_Customers', 'Clustered', 'c')}</IndexScan>`
                )}
                </Hash>`
              )}
              </Hash>`
            )}</ComputeScalar>`
        )}
        </Sort>`
      )}
    </QueryPlan>`
  )
);

// 5. Phone search: an nvarchar value against a varchar column, so the index can only be scanned
const CONVERT = wrap(
  stmt(
    "SELECT CustomerId, FirstName, Surname FROM dbo.Customers WHERE Phone = N'07700 900123'",
    0.0864873,
    1,
    `<QueryPlan DegreeOfParallelism="1" CachedPlanSize="32" CompileTime="2" CompileCPU="2" CompileMemory="304">
      <Warnings>
        <PlanAffectingConvert ConvertIssue="Cardinality Estimate" Expression="CONVERT_IMPLICIT(nvarchar(20),[Shop].[dbo].[Customers].[Phone],0)" />
        <PlanAffectingConvert ConvertIssue="Seek Plan" Expression="CONVERT_IMPLICIT(nvarchar(20),[Shop].[dbo].[Customers].[Phone],0)=N'07700 900123'" />
      </Warnings>
      ${relop(
        { NodeId: 0, PhysicalOp: 'Nested Loops', LogicalOp: 'Inner Join', EstimateRows: 1, EstimateIO: 0, EstimateCPU: 4.18e-6, AvgRowSize: 35, EstimatedTotalSubtreeCost: 0.0864873, EstimateRebinds: 0, EstimateRewinds: 0 },
        `${outputs(col('Customers', 'CustomerId'), col('Customers', 'FirstName'), col('Customers', 'Surname'))}${runtime(1)}
        <NestedLoops Optimized="0"><OuterReferences>${col('Customers', 'CustomerId')}</OuterReferences>
        ${relop(
          { NodeId: 1, PhysicalOp: 'Index Scan', LogicalOp: 'Index Scan', EstimateRows: 1, EstimatedRowsRead: 20000, EstimateIO: 0.0609028, EstimateCPU: 0.0222972, AvgRowSize: 11, EstimatedTotalSubtreeCost: 0.0832, TableCardinality: 20000, EstimateRebinds: 0, EstimateRewinds: 0 },
          `${outputs(col('Customers', 'CustomerId'))}${runtime(1, 1, 20000)}
          <IndexScan Ordered="0" ForcedIndex="0" ForceScan="0" NoExpandHint="0" Storage="RowStore">${object('Customers', 'IX_Customers_Phone', 'NonClustered')}
            <Predicate>${scalar("CONVERT_IMPLICIT(nvarchar(20),[Shop].[dbo].[Customers].[Phone],0)=N'07700 900123'")}</Predicate></IndexScan>`
        )}
        ${relop(
          { NodeId: 3, PhysicalOp: 'Clustered Index Seek', LogicalOp: 'Clustered Index Seek', EstimateRows: 1, EstimateIO: 0.003125, EstimateCPU: 0.0001581, AvgRowSize: 31, EstimatedTotalSubtreeCost: 0.0032831, TableCardinality: 20000, EstimateRebinds: 0, EstimateRewinds: 0 },
          `${outputs(col('Customers', 'FirstName'), col('Customers', 'Surname'))}${runtime(1, 1, 1)}
          <IndexScan Lookup="1" Ordered="1" ScanDirection="FORWARD" ForcedIndex="0" ForceSeek="0" ForceScan="0" NoExpandHint="0" Storage="RowStore">${object('Customers', 'PK_Customers', 'Clustered')}
            ${seekEq('Customers', 'CustomerId', '[Shop].[dbo].[Customers].[CustomerId]')}</IndexScan>`
        )}
        </NestedLoops>`
      )}
    </QueryPlan>`
  )
);

export const SAMPLES: SamplePlan[] = [
  {
    id: 'scan',
    title: 'Orders for one customer, no index',
    story:
      'A customer opens “My orders” on the website. The query asks for one customer’s orders, but the Orders table is stored in OrderId order and nothing helps SQL Server find a customer’s rows.',
    xml: SCAN,
  },
  {
    id: 'lookup',
    title: 'The same query, with an index',
    story:
      'After CREATE INDEX IX_Orders_CustomerId ON dbo.Orders (CustomerId), SQL Server can go straight to the customer’s orders. But the index only holds CustomerId and OrderId, so each order needs a trip back to the table for OrderDate and Total.',
    xml: LOOKUP,
  },
  {
    id: 'covering',
    title: 'With a covering index',
    story:
      'The index is rebuilt with INCLUDE (OrderDate, Total), so it holds every column the query needs. One seek, and the table itself isn’t touched.',
    xml: COVERING,
  },
  {
    id: 'report',
    title: 'Monthly sales report',
    story:
      'Finance runs October’s revenue by city, and today it’s slow. October’s orders were loaded after the statistics on OrderDate were last updated, so SQL Server expects far fewer rows than there are.',
    xml: REPORT,
  },
  {
    id: 'convert',
    title: 'Find a customer by phone number',
    story:
      'The support team searches by phone number. Phone is a varchar column with an index, but the application sends the number as nvarchar, as many data access libraries do by default for strings.',
    xml: CONVERT,
  },
];
