# Transport System Specification v1.1

## 1. Confirmed policy decisions

The following policy decisions are now confirmed and replace earlier recommendations:

1. Driver availability exceptions are manager-controlled.
   - A driver may submit a change request.
   - The request remains pending until approved or rejected by a manager.
   - Approved exception changes become active for the relevant period only.

2. Recurring bookings require weekly passenger confirmation.
   - A recurring arrangement remains active, but each upcoming week requires explicit approval by the passenger.
   - Unconfirmed recurring dates do not enter the dispatch queue.

3. Vehicle allocation is automatic.
   - The system automatically assigns vehicles and seats for eligible demand.
   - Managers retain override authority, but routine allocation does not need manual approval.

## 2. Business rules

### 2.1 Driver availability

- Drivers declare their standard weekly availability during registration or profile setup.
- Approved weekly availability remains active until changed.
- A driver may submit a temporary or permanent availability change request.
- Requests must include affected date/time and reason.
- Managers review each request and either approve or reject it.
- Pending exceptions do not affect the driver's approved schedule.
- Approved exceptions update the effective availability for the affected period.
- Existing assignments must be checked before approving a change.
- A manager must resolve any assignment conflicts before approving a conflicting availability change.
- Drivers cannot directly alter their approved schedule without manager authorisation.
- Actual operational status remains separate from approved availability.

### 2.2 Recurring booking confirmation

- Each recurring booking template requires weekly confirmation.
- The system prepares a weekly review for upcoming dates.
- The passenger may confirm, edit, skip, or adjust seat counts for selected dates.
- Only confirmed dates generate active bookings for dispatch.
- A missed weekly confirmation does not cancel the recurring template itself.
- The recurring template remains active until paused or cancelled.
- Confirmation deadline is configured centrally and enforced before dispatch.

### 2.3 Automatic allocation with manager override

- Passengers cannot choose a specific driver or vehicle.
- Allocation evaluates route, capacity, availability, and operational status.
- The system selects the most suitable vehicle and reserves seats.
- Managers can override allocations with a recorded reason.
- Allocation must never exceed physical vehicle capacity.
- Unavailable vehicles or drivers remain excluded from assignment.
- If no suitable vehicle is available, the booking remains queued safely.

## 3. Workflow rules

### 3.1 Driver availability exception workflow

Driver submits exception -> system marks request as Pending -> manager is notified -> manager approves or rejects -> approved change applies after conflict review -> audit is written -> driver is notified.

### 3.2 Weekly recurring booking confirmation workflow

Weekly job scans active templates -> generates weekly review -> notifies passenger -> passenger confirms or edits -> confirmed occurrences become active bookings -> unconfirmed dates remain queued but inactive -> reminder and deadline handling applies.

### 3.3 Automatic vehicle allocation workflow

Queue receives confirmed booking -> system groups compatible demand -> finds eligible drivers and vehicles -> checks route, approved availability, and capacity -> assigns suitable vehicle -> reserves seats -> notifies passenger and driver -> manager may override if required.

## 4. Database implications

### 4.1 Driver availability

Maintain a distinction between:

- approved weekly availability
- temporary availability exception requests
- actual operational driver status

Add or refine:

- DriverAvailability
- DriverAvailabilityExceptions
- Audit log records for manager decisions

### 4.2 Recurring booking confirmation

Add:

- RecurringBookingConfirmations
  - Id
  - RecurringBookingId
  - WeekStartDate
  - WeekEndDate
  - Status
  - ConfirmedAt
  - ConfirmationDeadline
  - PassengerId
  - CreatedAt

Refine recurring templates to include:

- Status
- StartDate
- EndDate
- ConfirmationRequired
- LastConfirmedWeekStart
- PausedAt
- CancelledAt

Ensure uniqueness constraints:

- one confirmation record per recurring booking and week
- one active occurrence per recurring booking and travel date

### 4.3 Dispatch allocation audit

Dispatch assignments should retain allocation history and store:

- AllocationMethod
- AllocationScore
- AssignedAt
- AssignedBy
- OverrideReason
- Status

History must not be overwritten when an assignment is changed.

## 5. API behaviour

### 5.1 Driver availability endpoints

- POST /drivers/me/availability-exceptions
  - creates a pending request
- GET /drivers/me/availability-exceptions
  - returns the driver's own requests and decisions
- GET /manager/availability-exceptions
  - returns pending/approved/rejected requests for the manager's scope
- POST /manager/availability-exceptions/{id}/approve
  - approves after conflict checks
- POST /manager/availability-exceptions/{id}/reject
  - rejects with a reason
- POST /manager/drivers/{id}/availability
  - manager changes approved availability directly with an audit record

### 5.2 Recurring booking endpoints

- POST /recurring-bookings
  - creates an active recurring template requiring weekly confirmation
- GET /recurring-bookings/{id}/weekly-review
  - returns upcoming date review data
- POST /recurring-bookings/{id}/weekly-confirmations
  - confirms selected occurrences with an idempotency key
- POST /recurring-bookings/{id}/skip-date
  - skips a specific date
- POST /recurring-bookings/{id}/pause
  - pauses future review generation
- POST /recurring-bookings/{id}/resume
  - resumes review generation
- POST /recurring-bookings/{id}/cancel
  - ends the recurring arrangement

### 5.3 Dispatch endpoints

- POST /dispatch/allocate
  - runs automatic allocation for eligible demand
- GET /dispatch/recommendations
  - returns candidate vehicles and allocation explanations
- GET /manager/dispatch/assignments
  - lists current assignments
- POST /manager/dispatch/assignments/{id}/override
  - allows manager override with reason
- POST /manager/dispatch/reallocate
  - recalculates pending allocations
- GET /manager/dispatch/surge
  - reports demand and supply shortfall

## 6. Acceptance criteria

- AC-21: A driver availability exception remains pending until manager approval.
- AC-22: A rejected exception does not change the approved weekly schedule.
- AC-23: An approved exception updates effective availability and triggers conflict checks.
- AC-24: A driver cannot directly alter an approved availability record.
- AC-25: A passenger receives a weekly recurring-booking review request.
- AC-26: Unconfirmed recurring dates do not enter the active dispatch queue.
- AC-27: Confirmed recurring dates generate individual booking records.
- AC-28: Repeated weekly confirmation requests do not create duplicate occurrences.
- AC-29: Automatic dispatch allocates suitable vehicles without routine manager confirmation.
- AC-30: Managers can override automatic assignments with a recorded reason.
- AC-31: Automatic allocation respects approved availability, actual vehicle status, and free capacity.
- AC-32: A failed automatic allocation leaves affected bookings safely queued.
- AC-33: Concurrent automatic allocation attempts cannot overbook a vehicle.

## 7. Implementation priority

1. Users, roles, stations, routes, driver profiles, vehicle registration
2. Driver availability schedules and manager approval workflows
3. Passenger one-time booking and queue management
4. Weekly recurring confirmation and occurrence generation
5. Automatic dispatch and manager overrides
6. Notifications, alerts, and pilot rollout

## 8. Authority model

The system now has three operational authorities:

- passengers confirm recurring demand each week
- managers control driver availability and operational exceptions
- the dispatch engine performs routine automatic allocation under manager oversight
