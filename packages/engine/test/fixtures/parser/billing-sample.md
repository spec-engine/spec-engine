---
key: BILLING
owner: drea
spec_version: 2
updated: 2026-06-02
---

### BILLING-001 — Superseded by BILLING-009
**Requirement:** When a subscription renews, charge the saved payment method at the current plan price.
**Why it matters:** Revenue path.
**Lives in:** renew.ts

### BILLING-009 — Active
**Requirement:** When a subscription renews, charge the saved payment method at the current plan price, prorating mid-cycle plan changes.
**Why it matters:** Revenue path; proration was the gap that drove the supersession.
**Binds:** plans.price, payment_methods
**Lives in:** renew.ts

### BILLING-002 — Active
**Requirement:** When a charge fails, retry on a schedule and notify the customer.
**Why it matters:** Dunning; silent failure churns the customer.
**Lives in:** charge.ts

### BILLING-007 — Active
**Requirement:** When a charge is made, compute tax per region at charge time.
**Why it matters:** Compliance.
**Lives in:** tax.ts
