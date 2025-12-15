import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { processGiftCardOrder, type OrderWebhookPayload } from "../services/giftcard.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!shop) {
    console.log("No shop in webhook payload, skipping");
    return new Response();
  }

  try {
    await processGiftCardOrder(shop, payload as OrderWebhookPayload);
  } catch (error) {
    console.error(`Error processing gift card order for ${shop}:`, error);
    // Don't throw - return 200 to acknowledge webhook receipt
    // Shopify will retry if we return error codes
  }

  return new Response();
};
