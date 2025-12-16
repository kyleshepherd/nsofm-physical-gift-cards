import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { formatCurrency } from "../utils/currency";

interface ShopSettings {
  variantIds: string[];
  sendEmailNotification: boolean;
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
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

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

  // Get settings from shop metafield
  const settings = await getShopSettings(admin);
  const productCount = settings.variantIds.length;

  // Query recent orders with gift cards
  const ordersResponse = await admin.graphql(
    `#graphql
    query getRecentOrdersWithGiftCards {
      orders(first: 50, sortKey: CREATED_AT, reverse: true) {
        nodes {
          id
          name
          createdAt
          metafield(namespace: "$app:gift_cards", key: "created_codes") {
            value
          }
        }
      }
    }`
  );

  const ordersData = await ordersResponse.json();
  const allOrders = ordersData.data?.orders?.nodes || [];

  // Filter to only orders with gift cards and calculate stats
  let giftCardCount = 0;
  let totalValue = 0;
  const recentOrders: { orderId: string; orderName: string; totalValue: number; createdAt: string; productTitles: string[] }[] = [];

  for (const order of allOrders) {
    if (order.metafield?.value) {
      try {
        const giftCardsData = JSON.parse(order.metafield.value);
        const orderTotalValue = giftCardsData.reduce(
          (sum: number, gc: any) => sum + parseFloat(gc.value),
          0
        );

        // Get unique product titles
        const productTitles = [...new Set(giftCardsData.map((gc: any) => gc.productTitle || "Gift Card"))] as string[];

        giftCardCount += giftCardsData.length;
        totalValue += orderTotalValue;

        if (recentOrders.length < 5) {
          recentOrders.push({
            orderId: order.id,
            orderName: order.name,
            totalValue: orderTotalValue,
            createdAt: order.createdAt,
            productTitles,
          });
        }
      } catch {
        // Invalid JSON, skip
      }
    }
  }

  return {
    productCount,
    giftCardCount,
    totalValue,
    recentOrders,
    currencyCode,
  };
};

export default function Index() {
  const { productCount, giftCardCount, totalValue, recentOrders, currencyCode } =
    useLoaderData<typeof loader>();

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <s-page heading="Physical Gift Cards">
      <s-button slot="primary-action" href="/app/settings">
        Configure Products
      </s-button>

      <s-section heading="Overview">
        <s-paragraph>
          Automatically create Shopify gift cards when customers purchase
          designated products. Perfect for selling physical gift cards that you
          print and package for customers.
        </s-paragraph>

        <s-stack direction="inline" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-heading>{productCount}</s-heading>
              <s-text>Gift Card Variants</s-text>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-heading>{giftCardCount}</s-heading>
              <s-text>Gift Cards Created</s-text>
            </s-stack>
          </s-box>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-heading>{formatCurrency(totalValue, currencyCode)}</s-heading>
              <s-text>Total Value</s-text>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      {productCount === 0 ? (
        <s-section heading="Get Started">
          <s-banner tone="info">
            <s-stack direction="block" gap="base">
              <s-text type="strong">No gift card products configured</s-text>
              <s-paragraph>
                To start generating gift cards, you need to select which
                products should trigger gift card creation when purchased.
              </s-paragraph>
              <s-button href="/app/settings">Configure Products</s-button>
            </s-stack>
          </s-banner>
        </s-section>
      ) : recentOrders.length > 0 ? (
        <s-section heading="Recent Gift Card Orders">
          <s-stack direction="block" gap="small">
            {recentOrders.map((order) => (
              <s-link
                key={order.orderId}
                href="/app/orders"
              >
                <s-box
                  padding="small"
                  borderWidth="base"
                  borderRadius="base"
                >
                  <s-stack direction="block" gap="small-200">
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-text type="strong">{order.orderName}</s-text>
                      <s-text>{formatCurrency(order.totalValue, currencyCode)}</s-text>
                      <s-text color="subdued">
                        {formatDate(order.createdAt)}
                      </s-text>
                    </s-stack>
                    <s-text color="subdued">{order.productTitles.join(", ")}</s-text>
                  </s-stack>
                </s-box>
              </s-link>
            ))}
          </s-stack>
          <s-box paddingBlockStart="base">
            <s-button href="/app/orders" variant="tertiary">
              View all orders
            </s-button>
          </s-box>
        </s-section>
      ) : (
        <s-section heading="Waiting for Orders">
          <s-banner tone="info">
            <s-paragraph>
              You have {productCount} variant{productCount !== 1 ? "s" : ""}{" "}
              configured. When customers purchase these products, gift cards
              will be automatically created and appear here.
            </s-paragraph>
          </s-banner>
        </s-section>
      )}

      <s-section slot="aside" heading="How it works">
        <s-unordered-list>
          <s-list-item>
            <s-text type="strong">1. Configure products</s-text>
            <s-paragraph>
              Select which products should generate gift cards when purchased.
            </s-paragraph>
          </s-list-item>
          <s-list-item>
            <s-text type="strong">2. Customer purchases</s-text>
            <s-paragraph>
              When a customer buys a configured product and pays, a gift card is
              automatically created.
            </s-paragraph>
          </s-list-item>
          <s-list-item>
            <s-text type="strong">3. View codes</s-text>
            <s-paragraph>
              View gift card codes in the Orders page or directly in the order
              notes. Print and package them as physical gift cards.
            </s-paragraph>
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Quick Links">
        <s-stack direction="block" gap="small">
          <s-link href="/app/orders">View Orders</s-link>
          <s-link href="/app/settings">Settings</s-link>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
