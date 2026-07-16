// A test file in a normal `test/` subdir (filename matches `.test.`) → kind is
// `verifies` (path-derived). `unit` is the optional LEVEL token, NOT the kind.
// Only ORDERS-001 is verified here; ORDERS-002 is implemented (src/orders.ts)
// but never verified → planted UNVERIFIED_REQ.

// @spec ORDERS-001 unit
export function testPlaceOrderReservesInventory(): boolean {
  return true;
}
