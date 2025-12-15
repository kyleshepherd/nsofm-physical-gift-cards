-- CreateTable
CREATE TABLE "GiftCardProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GiftCardRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderName" TEXT NOT NULL,
    "lineItemId" TEXT NOT NULL,
    "giftCardId" TEXT NOT NULL,
    "giftCardCode" TEXT NOT NULL,
    "value" DECIMAL NOT NULL,
    "customerId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "sendEmailNotification" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "GiftCardProduct_shop_idx" ON "GiftCardProduct"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "GiftCardProduct_shop_productId_key" ON "GiftCardProduct"("shop", "productId");

-- CreateIndex
CREATE INDEX "GiftCardRecord_shop_idx" ON "GiftCardRecord"("shop");

-- CreateIndex
CREATE INDEX "GiftCardRecord_orderId_idx" ON "GiftCardRecord"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_shop_key" ON "AppSettings"("shop");
