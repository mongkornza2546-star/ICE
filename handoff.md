# Handoff: Factory Order Cancel Button Feature

This document summarizes the changes made to introduce the order cancellation capability for **Factory Orders (สั่งน้ำแข็งจากโรงงาน)**.

---

## 📋 Summary of Work

We have implemented a **Cancel (ยกเลิก)** action on the factory order page. This rolls back the stock movement ledger by changing the status of a specific order from `'active'` to `'cancelled'`, which automatically adjusts stock balances and excludes it from daily summaries.

### 1. Database Changes
- **Migration File**: `supabase/migrations/0023_cancel_factory_order.sql`
- **Function**: `public.cancel_factory_order(p_movement_id uuid, p_reason text)`
  - **Access Control**: Limited to `admin` or `round_lead` roles.
  - **Transaction Locks**: Locks the service date to prevent race conditions during updates and ensures the day isn't already closed.
  - **Safety Check**: Validates that cancelling the order will not result in a negative stock balance on the truck.
  - **Audit Logging**: Inserts a log into `audit_logs` tracking the actor, reason, timestamp, and entity ID.
  - **Returns**: The updated daily factory order summary payload via `public.get_factory_order_summary`.

### 2. Frontend React Changes
- **File**: `src/FactoryOrderPage.tsx`
  - Integrated `cancelAction` using the `useRpcAction` hook pointing to `supabase.rpc('cancel_factory_order')`.
  - Added a `handleCancelOrder` handler that prompts the user for a cancellation reason (`window.prompt`) and validates it is non-empty before triggering the cancellation.
  - Reset feedback state when quantities or note values change.
  - Added the **"จัดการ" (Manage)** column header and the **"ยกเลิก" (Cancel)** button to the history row component.

### 3. Styling Changes
- **File**: `src/index.css`
  - Updated grid column sizing for the history table from 5 columns to 6 columns.
  - Added `.cancel-order-button` component class with custom color palettes, borders, transitions, and hover effects matching the premium look of the application.
  - Configured mobile responsive layout where the Cancel button spans full-width and aligns nicely on mobile card layouts.

### 4. Integration & Unit Tests
- **File**: `tests/factory-order-contract.integration.test.mjs`
  - Added cancellation fields (`cancelled_by`, `cancelled_at`, `cancellation_reason`) to the mock database schema.
  - Implemented the integration test case: `"cancel_factory_order changes status to cancelled, updates balance and audit log"`.

---

## 🔍 Verification & Testing

### How to Run Tests
1. **Run Integration Tests**:
   ```bash
   node --test tests/factory-order-contract.integration.test.mjs
   ```
2. **Run Vitest Component Tests**:
   ```bash
   npm run test:ui
   ```
3. **Run All Tests**:
   ```bash
   npm run test
   ```

---

## 📂 Modified Files

- [supabase/migrations/0023_cancel_factory_order.sql](file:///Users/bhusitt./Downloads/ส่งน้ำแข็ง/supabase/migrations/0023_cancel_factory_order.sql) [NEW]
- [src/FactoryOrderPage.tsx](file:///Users/bhusitt./Downloads/ส่งน้ำแข็ง/src/FactoryOrderPage.tsx) [MODIFY]
- [src/index.css](file:///Users/bhusitt./Downloads/ส่งน้ำแข็ง/src/index.css) [MODIFY]
- [tests/factory-order-contract.integration.test.mjs](file:///Users/bhusitt./Downloads/ส่งน้ำแข็ง/tests/factory-order-contract.integration.test.mjs) [MODIFY]
