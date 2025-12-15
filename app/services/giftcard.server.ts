import db from "../db.server";
import { unauthenticated } from "../shopify.server";

interface WebhookLineItem {
  id: number;
  product_id: number;
  variant_id: number;
  quantity: number;
  price: string;
  title: string;
  admin_graphql_api_id: string;
}

export interface OrderWebhookPayload {
  id: number;
  admin_graphql_api_id: string;
  name: string;
  email?: string;
  customer?: {
    id: number;
    admin_graphql_api_id: string;
    email?: string;
    first_name?: string;
    last_name?: string;
  };
  line_items: WebhookLineItem[];
}

interface CreatedGiftCard {
  lineItemId: string;
  giftCardId: string;
  code: string;
  maskedCode: string;
  value: string;
}

export async function processGiftCardOrder(
  shop: string,
  payload: OrderWebhookPayload
) {
  // 1. Check if we've already processed this order (idempotency)
  const existingRecords = await db.giftCardRecord.findFirst({
    where: {
      shop,
      orderId: payload.admin_graphql_api_id,
    },
  });

  if (existingRecords) {
    console.log(
      `Order ${payload.name} already processed, skipping duplicate webhook`
    );
    return;
  }

  // 2. Get all gift card variant IDs for this shop
  const giftCardProducts = await db.giftCardProduct.findMany({
    where: { shop },
    select: { variantId: true },
  });

  if (giftCardProducts.length === 0) {
    console.log(`No gift card variants configured for ${shop}`);
    return;
  }

  const giftCardVariantIds = new Set(
    giftCardProducts.map((p) => p.variantId)
  );

  // 3. Filter line items that are gift card variants
  const giftCardLineItems = payload.line_items.filter((item) => {
    const variantGid = `gid://shopify/ProductVariant/${item.variant_id}`;
    return giftCardVariantIds.has(variantGid);
  });

  if (giftCardLineItems.length === 0) {
    console.log(`No gift card variants in order ${payload.name}`);
    return;
  }

  // 4. Get app settings for email notification preference
  const settings = await db.appSettings.findUnique({
    where: { shop },
  });
  const sendEmail = settings?.sendEmailNotification ?? true;

  // 5. Get admin client for GraphQL operations
  const { admin } = await unauthenticated.admin(shop);

  // 6. Create gift cards for each line item (one per quantity)
  const createdGiftCards: CreatedGiftCard[] = [];

  // Build customer info for notes
  const customerName = payload.customer
    ? `${payload.customer.first_name || ""} ${payload.customer.last_name || ""}`.trim()
    : "Guest";
  const customerEmail = payload.customer?.email || payload.email || "No email";

  for (const lineItem of giftCardLineItems) {
    for (let i = 0; i < lineItem.quantity; i++) {
      try {
        const note = `Order: ${payload.name}\nProduct: ${lineItem.title}\nCustomer: ${customerName}\nEmail: ${customerEmail}`;
        const giftCard = await createGiftCard(
          admin,
          lineItem.price,
          note,
          payload.customer?.admin_graphql_api_id,
          sendEmail
        );

        if (giftCard) {
          createdGiftCards.push({
            lineItemId: lineItem.admin_graphql_api_id,
            giftCardId: giftCard.id,
            code: giftCard.code,
            maskedCode: giftCard.maskedCode,
            value: lineItem.price,
          });

          // Store record in database
          await db.giftCardRecord.create({
            data: {
              shop,
              orderId: payload.admin_graphql_api_id,
              orderName: payload.name,
              lineItemId: lineItem.admin_graphql_api_id,
              giftCardId: giftCard.id,
              giftCardCode: giftCard.code,
              value: parseFloat(lineItem.price),
              customerId: payload.customer?.admin_graphql_api_id,
              customerName: customerName !== "Guest" ? customerName : null,
              customerEmail: customerEmail !== "No email" ? customerEmail : null,
            },
          });
        }
      } catch (error) {
        console.error(
          `Failed to create gift card for line item ${lineItem.id}:`,
          error
        );
        // Continue with other line items
      }
    }
  }

  // 7. Store gift card codes as metafield on order
  if (createdGiftCards.length > 0) {
    try {
      await setOrderGiftCardMetafield(
        admin,
        payload.admin_graphql_api_id,
        createdGiftCards
      );
    } catch (error) {
      console.error(`Failed to set metafield on order ${payload.name}:`, error);
      // Gift cards were still created successfully
    }
  }

  console.log(
    `Created ${createdGiftCards.length} gift cards for order ${payload.name}`
  );
}

async function createGiftCard(
  admin: any,
  value: string,
  note: string,
  customerId: string | undefined,
  sendEmail: boolean
): Promise<{ id: string; code: string; maskedCode: string } | null> {
  const response = await admin.graphql(
    `#graphql
    mutation giftCardCreate($input: GiftCardCreateInput!) {
      giftCardCreate(input: $input) {
        giftCard {
          id
          maskedCode
          lastCharacters
          initialValue {
            amount
          }
        }
        giftCardCode
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        input: {
          initialValue: value,
          note,
          // Only associate with customer if we want to send email notification
          // (associating a customer automatically triggers the notification email)
          ...(sendEmail && customerId && { customerId }),
        },
      },
    }
  );

  const data = await response.json();

  if (data.data?.giftCardCreate?.userErrors?.length > 0) {
    console.error(
      "Gift card creation errors:",
      data.data.giftCardCreate.userErrors
    );
    return null;
  }

  const giftCard = data.data?.giftCardCreate?.giftCard;
  const code = data.data?.giftCardCreate?.giftCardCode;

  if (!giftCard || !code) {
    console.error("Failed to create gift card - no data returned");
    return null;
  }

  if (sendEmail && customerId) {
    console.log(`Gift card ${giftCard.id} created with customer association - notification sent automatically`);
  }

  return {
    id: giftCard.id,
    code: code,
    maskedCode: giftCard.maskedCode,
  };
}

async function setOrderGiftCardMetafield(
  admin: any,
  orderId: string,
  giftCards: CreatedGiftCard[]
) {
  // Store codes for admin viewing/printing
  const metafieldValue = JSON.stringify(
    giftCards.map((gc) => ({
      code: gc.code,
      value: gc.value,
      maskedCode: gc.maskedCode,
      giftCardId: gc.giftCardId,
    }))
  );

  const response = await admin.graphql(
    `#graphql
    mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          namespace
          key
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            ownerId: orderId,
            namespace: "$app:gift_cards",
            key: "created_codes",
            type: "json",
            value: metafieldValue,
          },
        ],
      },
    }
  );

  const data = await response.json();

  if (data.data?.metafieldsSet?.userErrors?.length > 0) {
    console.error("Metafield set errors:", data.data.metafieldsSet.userErrors);
    throw new Error("Failed to set metafield");
  }
}
