import { useEffect, useState, useCallback } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { formatCurrency } from "../utils/currency";

interface VariantInfo {
  id: string;
  title: string;
  price: string;
}

interface ProductInfo {
  id: string;
  title: string;
  handle: string;
  variants: VariantInfo[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

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

  // Get configured gift card products with variants from DB
  const giftCardProducts = await db.giftCardProduct.findMany({
    where: { shop: session.shop },
    select: { productId: true, variantId: true },
  });

  // Get app settings
  let settings = await db.appSettings.findUnique({
    where: { shop: session.shop },
  });

  if (!settings) {
    settings = await db.appSettings.create({
      data: {
        shop: session.shop,
        sendEmailNotification: true,
      },
    });
  }

  // Group variants by product ID
  const productVariantMap = new Map<string, string[]>();
  for (const gcp of giftCardProducts) {
    const existing = productVariantMap.get(gcp.productId) || [];
    existing.push(gcp.variantId);
    productVariantMap.set(gcp.productId, existing);
  }

  // Fetch product and variant details for display
  const products: ProductInfo[] = [];
  for (const [productId, variantIds] of productVariantMap) {
    try {
      const response = await admin.graphql(
        `#graphql
        query getProduct($id: ID!) {
          product(id: $id) {
            id
            title
            handle
            variants(first: 100) {
              nodes {
                id
                title
                price
              }
            }
          }
        }`,
        {
          variables: { id: productId },
        },
      );
      const data = await response.json();
      if (data.data?.product) {
        const product = data.data.product;
        // Filter to only show variants we have stored
        const selectedVariants = product.variants.nodes.filter(
          (v: VariantInfo) => variantIds.includes(v.id),
        );
        products.push({
          id: product.id,
          title: product.title,
          handle: product.handle,
          variants: selectedVariants,
        });
      }
    } catch (error) {
      console.error(`Failed to fetch product ${productId}:`, error);
    }
  }

  return {
    products,
    sendEmailNotification: settings.sendEmailNotification,
    currencyCode,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "addProducts") {
    // Data structure: [{ productId, variants: [{ id }] }]
    const productsData = JSON.parse(formData.get("productsData") as string);

    for (const product of productsData) {
      for (const variant of product.variants) {
        await db.giftCardProduct.upsert({
          where: {
            shop_variantId: {
              shop: session.shop,
              variantId: variant.id,
            },
          },
          create: {
            shop: session.shop,
            productId: product.id,
            variantId: variant.id,
          },
          update: {},
        });
      }
    }

    return { success: true, action: "addProducts" };
  }

  if (intent === "removeVariant") {
    const variantId = formData.get("variantId") as string;

    await db.giftCardProduct.deleteMany({
      where: {
        shop: session.shop,
        variantId,
      },
    });

    return { success: true, action: "removeVariant" };
  }

  if (intent === "removeProduct") {
    const productId = formData.get("productId") as string;

    await db.giftCardProduct.deleteMany({
      where: {
        shop: session.shop,
        productId,
      },
    });

    return { success: true, action: "removeProduct" };
  }

  if (intent === "updateSettings") {
    const sendEmailNotification =
      formData.get("sendEmailNotification") === "true";

    await db.appSettings.upsert({
      where: { shop: session.shop },
      create: {
        shop: session.shop,
        sendEmailNotification,
      },
      update: {
        sendEmailNotification,
      },
    });

    return { success: true, action: "updateSettings" };
  }

  return { success: false };
};

export default function SettingsPage() {
  const { products, sendEmailNotification, currencyCode } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [emailEnabled, setEmailEnabled] = useState(sendEmailNotification);

  const isLoading = fetcher.state !== "idle";

  const handleSelectProducts = useCallback(async () => {
    // Build selection IDs from currently selected products/variants
    const selectionIds = products.map((p) => ({
      id: p.id,
      variants: p.variants.map((v) => ({ id: v.id })),
    }));

    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds,
      filter: {
        variants: true,
      },
    });

    if (selected && selected.length > 0) {
      // Products come back with their selected variants
      const productsData = (selected as any[]).map((product) => ({
        id: product.id,
        variants: product.variants.map((v: any) => ({ id: v.id })),
      }));

      fetcher.submit(
        {
          intent: "addProducts",
          productsData: JSON.stringify(productsData),
        },
        { method: "POST" },
      );
    }
  }, [shopify, products, fetcher]);

  const handleRemoveProduct = useCallback(
    (productId: string) => {
      fetcher.submit(
        {
          intent: "removeProduct",
          productId,
        },
        { method: "POST" },
      );
    },
    [fetcher],
  );

  const handleRemoveVariant = useCallback(
    (variantId: string) => {
      fetcher.submit(
        {
          intent: "removeVariant",
          variantId,
        },
        { method: "POST" },
      );
    },
    [fetcher],
  );

  const handleToggleEmail = useCallback(() => {
    const newValue = !emailEnabled;
    setEmailEnabled(newValue);
    fetcher.submit(
      {
        intent: "updateSettings",
        sendEmailNotification: newValue.toString(),
      },
      { method: "POST" },
    );
  }, [emailEnabled, fetcher]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success) {
      if (fetcher.data.action === "addProducts") {
        shopify.toast.show("Products updated");
      } else if (fetcher.data.action === "removeProduct") {
        shopify.toast.show("Product removed");
      } else if (fetcher.data.action === "removeVariant") {
        shopify.toast.show("Variant removed");
      } else if (fetcher.data.action === "updateSettings") {
        shopify.toast.show("Settings saved");
      }
    }
  }, [fetcher.state, fetcher.data, shopify]);

  // Sync local state with loader data
  useEffect(() => {
    setEmailEnabled(sendEmailNotification);
  }, [sendEmailNotification]);

  return (
    <s-page heading="Settings">
      <s-section heading="Gift Card Products">
        <s-paragraph>
          Products selected here will automatically generate gift cards when
          purchased. Each unit purchased creates one gift card with a value
          equal to the line item price.
        </s-paragraph>

        {products.length === 0 ? (
          <s-box padding="large">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-text color="subdued">No products selected</s-text>
              <s-paragraph color="subdued">
                Select products that should generate gift cards when purchased.
              </s-paragraph>
              <s-button onClick={handleSelectProducts}>
                Select Products
              </s-button>
            </s-stack>
          </s-box>
        ) : (
          <s-stack direction="block" gap="base">
            {products.map((product) => (
              <s-box
                key={product.id}
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
                      <s-text type="strong">{product.title}</s-text>
                      <s-text color="subdued">{product.handle}</s-text>
                    </s-stack>
                    <s-button
                      variant="tertiary"
                      tone="critical"
                      onClick={() => handleRemoveProduct(product.id)}
                      disabled={isLoading}
                    >
                      Remove All
                    </s-button>
                  </s-stack>
                  <s-stack direction="block" gap="small">
                    {product.variants.map((variant) => (
                      <s-box
                        key={variant.id}
                        padding="small"
                        background="subdued"
                        borderRadius="base"
                      >
                        <s-stack
                          direction="inline"
                          gap="base"
                          alignItems="center"
                          justifyContent="space-between"
                        >
                          <s-stack
                            direction="inline"
                            gap="base"
                            alignItems="center"
                          >
                            <s-text>{variant.title}</s-text>
                            <s-text color="subdued">
                              {formatCurrency(
                                Number(variant.price),
                                currencyCode,
                              )}
                            </s-text>
                          </s-stack>
                          <s-button
                            variant="tertiary"
                            tone="critical"
                            onClick={() => handleRemoveVariant(variant.id)}
                            disabled={isLoading}
                          >
                            Remove
                          </s-button>
                        </s-stack>
                      </s-box>
                    ))}
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
            <s-button variant="secondary" onClick={handleSelectProducts}>
              Select Products
            </s-button>
          </s-stack>
        )}
      </s-section>

      <s-section heading="Email Notifications">
        <s-paragraph>
          Control whether customers receive email notifications when gift cards
          are created for their orders.
        </s-paragraph>

        <s-box padding="base">
          <s-checkbox
            checked={emailEnabled}
            onChange={handleToggleEmail}
            label="Send email notification to customers when gift card is created"
          />
        </s-box>

        <s-banner tone="info">
          When enabled, customers will receive an email with their gift card
          code(s) after their order is paid. The store admin can always view and
          print codes from the Orders page regardless of this setting.
        </s-banner>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
