export type NotificationType =
  | "fame-buy"
  | "fame-sell"
  | "fame-nft-mint"
  | "fame-nft-burn";

export function isNotificationType(value: string): value is NotificationType {
  try {
    asNotificationType(value);
    return true;
  } catch (error) {
    return false;
  }
}

export function asNotificationType(value: string): NotificationType {
  switch (value) {
    case "fame-buy":
    case "fame-sell":
    case "fame-nft-mint":
    case "fame-nft-burn":
      return value as NotificationType;
  }
  throw new Error("Invalid notification type");
}
