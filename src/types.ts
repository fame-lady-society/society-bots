export type NotificationType =
  | "fame-buy"
  | "fame-sell";

export function isNotificationType(value: string): value is NotificationType {
  return value === "fame-buy" || value === "fame-sell";
}

export function asNotificationType(value: string): NotificationType {
  switch (value) {
    case "fame-buy":
    case "fame-sell":
      return value as NotificationType;
  }
  throw new Error("Invalid notification type");
}
