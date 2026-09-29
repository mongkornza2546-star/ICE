export interface EmployeeEventSummary {
  id: string;
  name: string;
  location: string;
  start_date: string;
  end_date: string;
  preparation_start_date?: string | null;
  active_participation_count: number;
}

export interface EmployeeEventBooth {
  id: string;
  event_job_id: string;
  shop_id: string;
  booth_number: string;
  event_zone: string | null;
  shop_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  start_date: string;
  end_date: string;
  preparation_start_date?: string | null;
  tank_handoff_count: number;
  tank_return_count: number;
  tank_balance: number;
  tank_rental_unit_price: number;
}

export interface EmployeeEventDetail {
  event: EmployeeEventSummary;
  booths: EmployeeEventBooth[];
}

export interface EmployeeEventBoothInput {
  eventJobId: string;
  requestId: string;
  boothNumber: string;
  shopName: string;
  eventZone: string;
  contactName: string;
  contactPhone: string;
}

export interface EmployeeEventBoothResult {
  created: boolean;
  duplicate: boolean;
  booth: EmployeeEventBooth;
}

export interface EmployeeTankHandoffInput {
  participationId: string;
  quantity: number;
  note: string;
  requestId: string;
}

export interface EmployeeTankHandoffResult {
  id: string;
  event_participation_id: string;
  quantity: number;
  service_date: string;
  rental_unit_price: number;
  charge_id?: string | null;
  charge_number?: string | null;
}

export interface EmployeeEventGateway {
  loadEvents(): Promise<EmployeeEventSummary[]>;
  loadEvent(eventJobId: string): Promise<EmployeeEventDetail>;
  createBooth(input: EmployeeEventBoothInput): Promise<EmployeeEventBoothResult>;
  handoffTanks(input: EmployeeTankHandoffInput): Promise<EmployeeTankHandoffResult>;
}
