import type {
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
import { useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { formatCurrency } from "../utils/currency";

const ORDERS_PER_PAGE = 10;

interface GiftCardInfo {
  code: string;
  value: string;
  maskedCode: string;
  giftCardId: string;
  currentBalance: number;
  productTitle: string;
}

interface OrderWithGiftCards {
  orderId: string;
  orderName: string;
  customerName: string | null;
  customerEmail: string | null;
  giftCards: GiftCardInfo[];
  totalValue: number;
  createdAt: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const direction = url.searchParams.get("direction") || "next";

  // Get shop currency
  const shopResponse = await admin.graphql(
    `#graphql
    query getShopCurrency {
      shop {
        currencyCode
      }
    }`,
  );
  const shopData = await shopResponse.json();
  const currencyCode = shopData.data?.shop?.currencyCode || "USD";

  // Query orders that have our gift card metafield
  // We fetch more than needed to filter, then paginate
  const paginationArgs = direction === "prev" && cursor
    ? `last: 50, before: "${cursor}"`
    : cursor
      ? `first: 50, after: "${cursor}"`
      : `first: 50`;

  const ordersResponse = await admin.graphql(
    `#graphql
    query getOrdersWithGiftCards {
      orders(${paginationArgs}, sortKey: CREATED_AT, reverse: true) {
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
        nodes {
          id
          name
          createdAt
          customer {
            displayName
            email
          }
          metafield(namespace: "$app:gift_cards", key: "created_codes") {
            value
          }
        }
      }
    }`
  );

  const ordersData = await ordersResponse.json();
  const allOrders = ordersData.data?.orders?.nodes || [];
  const pageInfo = ordersData.data?.orders?.pageInfo;

  // Filter to only orders with gift cards
  const ordersWithGiftCards = allOrders.filter(
    (order: any) => order.metafield?.value
  );

  // Parse gift card data and fetch current balances
  const orders: OrderWithGiftCards[] = [];
  const allGiftCardIds: string[] = [];

  for (const order of ordersWithGiftCards) {
    try {
      const giftCardsData = JSON.parse(order.metafield.value);
      for (const gc of giftCardsData) {
        allGiftCardIds.push(gc.giftCardId);
      }
    } catch {
      // Invalid JSON, skip
    }
  }

  // Fetch current balances for all gift cards
  const balanceMap = new Map<string, number>();
  if (allGiftCardIds.length > 0) {
    for (let i = 0; i < allGiftCardIds.length; i += 100) {
      const batch = allGiftCardIds.slice(i, i + 100);
      try {
        const response = await admin.graphql(
          `#graphql
          query getGiftCardBalances($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on GiftCard {
                id
                balance {
                  amount
                }
              }
            }
          }`,
          { variables: { ids: batch } },
        );
        const data = await response.json();
        for (const node of data.data?.nodes || []) {
          if (node?.id && node?.balance) {
            balanceMap.set(node.id, parseFloat(node.balance.amount));
          }
        }
      } catch (error) {
        console.error("Failed to fetch gift card balances:", error);
      }
    }
  }

  // Build order list with gift card info
  for (const order of ordersWithGiftCards) {
    try {
      const giftCardsData = JSON.parse(order.metafield.value);
      const giftCards: GiftCardInfo[] = giftCardsData.map((gc: any) => ({
        code: gc.code,
        value: gc.value,
        maskedCode: gc.maskedCode,
        giftCardId: gc.giftCardId,
        currentBalance: balanceMap.get(gc.giftCardId) ?? parseFloat(gc.value),
        productTitle: gc.productTitle || "Gift Card",
      }));

      orders.push({
        orderId: order.id,
        orderName: order.name,
        customerName: order.customer?.displayName || null,
        customerEmail: order.customer?.email || null,
        giftCards,
        totalValue: giftCards.reduce((sum, gc) => sum + parseFloat(gc.value), 0),
        createdAt: order.createdAt,
      });
    } catch {
      // Invalid JSON, skip
    }
  }

  return {
    orders: orders.slice(0, ORDERS_PER_PAGE),
    currencyCode,
    hasNextPage: pageInfo?.hasNextPage || orders.length > ORDERS_PER_PAGE,
    hasPreviousPage: pageInfo?.hasPreviousPage || false,
    nextCursor: pageInfo?.endCursor,
    prevCursor: pageInfo?.startCursor,
  };
};

export default function OrdersPage() {
  const { orders, currencyCode, hasNextPage, hasPreviousPage, nextCursor, prevCursor } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const shopify = useAppBridge();

  const goToNextPage = () => {
    if (nextCursor) {
      setSearchParams({ cursor: nextCursor, direction: "next" });
    }
  };

  const goToPrevPage = () => {
    if (prevCursor) {
      setSearchParams({ cursor: prevCursor, direction: "prev" });
    }
  };

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    shopify.toast.show("Code copied to clipboard");
  };

  const getGiftCardStatus = (gc: GiftCardInfo) => {
    const value = parseFloat(gc.value);
    const isRedeemed = gc.currentBalance < value;
    const isFullyRedeemed = gc.currentBalance === 0;

    return { isRedeemed, isFullyRedeemed };
  };

  const handleViewOrder = (orderId: string) => {
    const numericId = orderId.split("/").pop();
    window.open(`shopify://admin/orders/${numericId}`, "_top");
  };

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatGiftCardCode = (code: string) => {
    return (code.match(/.{1,4}/g)?.join(" ") || code).toUpperCase();
  };

  return (
    <s-page heading="Orders with Gift Cards">
      <s-section heading="Recent Orders">
        <s-paragraph>
          View orders that have generated gift cards. Click on a code to copy it
          for printing physical gift cards.
        </s-paragraph>

        {orders.length === 0 ? (
          <s-box padding="large">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-text color="subdued">No gift card orders yet</s-text>
              <s-paragraph color="subdued">
                Orders containing physical gift card products will appear here
                after they are paid.
              </s-paragraph>
              <s-button href="/app/settings">
                Configure Gift Card Products
              </s-button>
            </s-stack>
          </s-box>
        ) : (
          <s-stack direction="block" gap="large">
            <s-stack
              direction="inline"
              gap="base"
              alignItems="center"
              justifyContent="space-between"
            >
              <s-text color="subdued">
                Showing {orders.length} orders
              </s-text>
              {(hasNextPage || hasPreviousPage) && (
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-button
                    variant="tertiary"
                    disabled={!hasPreviousPage}
                    onClick={goToPrevPage}
                  >
                    Previous
                  </s-button>
                  <s-button
                    variant="tertiary"
                    disabled={!hasNextPage}
                    onClick={goToNextPage}
                  >
                    Next
                  </s-button>
                </s-stack>
              )}
            </s-stack>
            {orders.map((order) => (
              <s-box
                key={order.orderId}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base">
                  <s-stack
                    direction="inline"
                    gap="base"
                    alignItems="center"
                    justifyContent="space-between"
                  >
                    <s-stack direction="block" gap="small-200">
                      <s-text type="strong">{order.orderName}</s-text>
                      {(order.customerName || order.customerEmail) && (
                        <s-text color="subdued">
                          {order.customerName || order.customerEmail}
                        </s-text>
                      )}
                      <s-text color="subdued">
                        {formatDate(order.createdAt)}
                      </s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="base" alignItems="center">
                      <s-badge>
                        {order.giftCards.length} gift card
                        {order.giftCards.length !== 1 ? "s" : ""}
                      </s-badge>
                      <s-text type="strong">
                        {formatCurrency(order.totalValue, currencyCode)} total
                      </s-text>
                      <s-button
                        variant="tertiary"
                        onClick={() => handleViewOrder(order.orderId)}
                      >
                        View Order
                      </s-button>
                    </s-stack>
                  </s-stack>

                  <s-divider />

                  <s-stack direction="block" gap="small">
                    <s-text type="strong">Gift Card Codes:</s-text>
                    {order.giftCards.map((gc, index) => {
                      const { isRedeemed, isFullyRedeemed } =
                        getGiftCardStatus(gc);
                      const isDisabled = isFullyRedeemed || isRedeemed;

                      return (
                        <s-box
                          key={gc.giftCardId}
                          padding="small"
                          background="subdued"
                          borderRadius="base"
                        >
                          <s-stack direction="block" gap="small">
                            <s-stack
                              direction="inline"
                              gap="base"
                              alignItems="center"
                              inlineSize="100%"
                            >
                              <s-text color="subdued">#{index + 1}</s-text>
                              <s-box
                                padding="small"
                                background={isDisabled ? "subdued" : "base"}
                                borderRadius="base"
                                borderWidth="base"
                                inlineSize="100%"
                              >
                                <s-stack direction="block" gap="small-200">
                                  <s-text color="subdued">{gc.productTitle}</s-text>
                                  <s-text
                                    type="strong"
                                    color={isDisabled ? "subdued" : "base"}
                                  >
                                    {formatGiftCardCode(gc.code)}
                                  </s-text>
                                </s-stack>
                              </s-box>
                              <s-text color={isDisabled ? "subdued" : "base"}>
                                {formatCurrency(parseFloat(gc.value), currencyCode)}
                              </s-text>
                              {!isDisabled && (
                                <s-button
                                  variant="tertiary"
                                  onClick={() => handleCopyCode(gc.code)}
                                >
                                  Copy
                                </s-button>
                              )}
                            </s-stack>
                            <s-stack direction="inline" gap="small">
                              {isFullyRedeemed && (
                                <s-badge tone="info">Fully Redeemed</s-badge>
                              )}
                              {isRedeemed && !isFullyRedeemed && (
                                <s-badge tone="warning">
                                  Partially Used ({formatCurrency(gc.currentBalance, currencyCode)} remaining)
                                </s-badge>
                              )}
                            </s-stack>
                          </s-stack>
                        </s-box>
                      );
                    })}
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
            {(hasNextPage || hasPreviousPage) && (
              <s-stack
                direction="inline"
                gap="small"
                alignItems="center"
                justifyContent="center"
              >
                <s-button
                  variant="tertiary"
                  disabled={!hasPreviousPage}
                  onClick={goToPrevPage}
                >
                  Previous
                </s-button>
                <s-button
                  variant="tertiary"
                  disabled={!hasNextPage}
                  onClick={goToNextPage}
                >
                  Next
                </s-button>
              </s-stack>
            )}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="About Gift Card Codes">
        <s-paragraph>
          Gift card codes are generated automatically when orders containing
          designated gift card products are paid.
        </s-paragraph>
        <s-paragraph>
          Each code can be printed on a physical gift card and given to the
          customer. The code can be redeemed at checkout.
        </s-paragraph>
        <s-paragraph>
          <s-text type="strong">Note:</s-text> Gift card codes are also added
          to the order notes in Shopify for easy access.
        </s-paragraph>
        <s-paragraph>
          <s-text type="strong">Security Note:</s-text> Gift card codes should
          be treated like cash. Only share codes with intended recipients.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
