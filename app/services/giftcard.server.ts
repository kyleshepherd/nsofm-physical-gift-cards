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
  note?: string;
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
  productTitle: string;
}

interface ShopSettings {
  variantIds: string[];
  sendEmailNotification: boolean;
  printedOverhead: number;
}

function formatGiftCardCode(code: string): string {
  return (code.match(/.{1,4}/g)?.join(" ") || code).toUpperCase();
}

export async function processGiftCardOrder(
  shop: string,
  payload: OrderWebhookPayload
) {
  // Get admin client for GraphQL operations
  const { admin } = await unauthenticated.admin(shop);

  // Get shop currency
  const shopResponse = await admin.graphql(
    `#graphql
    query getShopCurrency {
      shop {
        currencyCode
      }
    }`
  );
  const shopData = await shopResponse.json();
  const currencyCode = shopData.data?.shop?.currencyCode || "USD";

  // 1. Check if we've already processed this order (check for metafield)
  const orderCheckResponse = await admin.graphql(
    `#graphql
    query checkOrderMetafield($id: ID!) {
      order(id: $id) {
        metafield(namespace: "$app:gift_cards", key: "created_codes") {
          value
        }
      }
    }`,
    { variables: { id: payload.admin_graphql_api_id } }
  );
  const orderCheckData = await orderCheckResponse.json();

  if (orderCheckData.data?.order?.metafield?.value) {
    console.log(
      `Order ${payload.name} already processed, skipping duplicate webhook`
    );
    return;
  }

  // 2. Get shop settings from metafield
  const settings = await getShopSettings(admin);

  if (settings.variantIds.length === 0) {
    console.log(`No gift card variants configured for ${shop}`);
    return;
  }

  const giftCardVariantIds = new Set(settings.variantIds);

  // 3. Filter line items that are gift card variants
  const giftCardLineItems = payload.line_items.filter((item) => {
    const variantGid = `gid://shopify/ProductVariant/${item.variant_id}`;
    return giftCardVariantIds.has(variantGid);
  });

  if (giftCardLineItems.length === 0) {
    console.log(`No gift card variants in order ${payload.name}`);
    return;
  }

  // 4. Create gift cards for each line item (one per quantity)
  const createdGiftCards: CreatedGiftCard[] = [];

  // Build customer info for notes
  const customerName = payload.customer
    ? `${payload.customer.first_name || ""} ${payload.customer.last_name || ""}`.trim()
    : "Guest";
  const customerEmail = payload.customer?.email || payload.email || "No email";

  for (const lineItem of giftCardLineItems) {
    // Calculate gift card value by subtracting the printed overhead
    const lineItemPrice = parseFloat(lineItem.price);
    const overhead = settings.printedOverhead || 0;
    const giftCardValue = Math.max(0, lineItemPrice - overhead).toFixed(2);

    for (let i = 0; i < lineItem.quantity; i++) {
      try {
        const giftCard = await createGiftCard(
          admin,
          giftCardValue,
          payload.name,
          lineItem.title,
          customerName,
          customerEmail,
          payload.customer?.admin_graphql_api_id,
          settings.sendEmailNotification,
          currencyCode
        );

        if (giftCard) {
          createdGiftCards.push({
            lineItemId: lineItem.admin_graphql_api_id,
            giftCardId: giftCard.id,
            code: giftCard.code,
            maskedCode: giftCard.maskedCode,
            value: giftCardValue,
            productTitle: lineItem.title,
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

  // 5. Store gift card codes as metafield on order and add to order notes
  if (createdGiftCards.length > 0) {
    try {
      await updateOrderWithGiftCards(
        admin,
        payload.admin_graphql_api_id,
        createdGiftCards,
        payload.note,
        currencyCode
      );
    } catch (error) {
      console.error(`Failed to update order ${payload.name}:`, error);
      // Gift cards were still created successfully
    }
  }

  console.log(
    `Created ${createdGiftCards.length} gift cards for order ${payload.name}`
  );
}

async function getShopSettings(admin: any): Promise<ShopSettings> {
  const response = await admin.graphql(
    `#graphql
    query getShopMetafields {
      shop {
        metafield(namespace: "$app:gift_cards", key: "settings") {
          value
        }
      }
    }`
  );

  const data = await response.json();
  const settingsValue = data.data?.shop?.metafield?.value;

  if (settingsValue) {
    try {
      return JSON.parse(settingsValue);
    } catch {
      // Invalid JSON, return defaults
    }
  }

  return {
    variantIds: [],
    sendEmailNotification: true,
    printedOverhead: 0,
  };
}

async function createGiftCard(
  admin: any,
  value: string,
  orderName: string,
  productTitle: string,
  customerName: string,
  customerEmail: string,
  customerId: string | undefined,
  sendEmail: boolean,
  currencyCode: string
): Promise<{ id: string; code: string; maskedCode: string } | null> {
  // Note will include the full code after creation
  const initialNote = `Order: ${orderName}\nProduct: ${productTitle}\nCustomer: ${customerName}\nEmail: ${customerEmail}\nValue: ${value} ${currencyCode}`;

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
          note: initialNote,
          // Only associate with customer if we want to send email notification
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

  // Update the gift card note to include the full code (formatted)
  const formattedCode = formatGiftCardCode(code);
  const fullNote = `Order: ${orderName}\nProduct: ${productTitle}\nCustomer: ${customerName}\nEmail: ${customerEmail}\nValue: ${value} ${currencyCode}\n\nFull Code: ${formattedCode}`;

  await admin.graphql(
    `#graphql
    mutation giftCardUpdate($id: ID!, $input: GiftCardUpdateInput!) {
      giftCardUpdate(id: $id, input: $input) {
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        id: giftCard.id,
        input: {
          note: fullNote,
        },
      },
    }
  );

  if (sendEmail && customerId) {
    console.log(`Gift card ${giftCard.id} created with customer association - notification sent automatically`);
  }

  return {
    id: giftCard.id,
    code: code,
    maskedCode: giftCard.maskedCode,
  };
}

async function updateOrderWithGiftCards(
  admin: any,
  orderId: string,
  giftCards: CreatedGiftCard[],
  existingNote: string | undefined,
  currencyCode: string
) {
  // Build the gift card note section
  const giftCardNoteLines = giftCards.map((gc, index) => {
    const formattedCode = formatGiftCardCode(gc.code);
    return `Gift Card #${index + 1}: ${formattedCode}\nProduct: ${gc.productTitle}\nValue: ${gc.value} ${currencyCode}`;
  });

  const giftCardNote = `\n\n--- Physical Gift Cards ---\n${giftCardNoteLines.join("\n\n")}`;
  const newNote = (existingNote || "") + giftCardNote;

  // Store codes as metafield for app viewing
  const metafieldValue = JSON.stringify(
    giftCards.map((gc) => ({
      code: gc.code,
      value: gc.value,
      maskedCode: gc.maskedCode,
      giftCardId: gc.giftCardId,
      productTitle: gc.productTitle,
    }))
  );

  const response = await admin.graphql(
    `#graphql
    mutation updateOrderWithGiftCards($orderId: ID!, $note: String!, $metafields: [MetafieldsSetInput!]!) {
      orderUpdate(input: { id: $orderId, note: $note }) {
        order {
          id
        }
        userErrors {
          field
          message
        }
      }
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        orderId,
        note: newNote,
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

  if (data.data?.orderUpdate?.userErrors?.length > 0) {
    console.error("Order update errors:", data.data.orderUpdate.userErrors);
  }

  if (data.data?.metafieldsSet?.userErrors?.length > 0) {
    console.error("Metafield set errors:", data.data.metafieldsSet.userErrors);
  }
}
