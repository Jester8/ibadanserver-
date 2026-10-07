/** What each kind of business sells, so the server can charge the right price. */
export const BIZ_INFO: Record<string, { name: string; item: string; price: number }> = {
  shop: { name: "Corner shop", item: "snacks and a cold drink", price: 800 },
  salon: { name: "Barber & salon", item: "a fresh cut", price: 2500 },
  cafe: { name: "Cafe", item: "coffee and a pastry", price: 1500 },
  pharmacy: { name: "Pharmacy", item: "vitamins", price: 1200 },
  gym: { name: "Gym", item: "a day-pass workout", price: 2000 },
  mart: { name: "Supermarket", item: "a big shop", price: 3500 },
};
export const DEFAULT_WAGE = 2500;
export const MAX_WAGE = 20_000;
