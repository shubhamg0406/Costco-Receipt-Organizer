const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("receiptDesktop", {
  openReceiptFolder: receiptId => ipcRenderer.invoke("open-receipt-folder", receiptId),
  copyReceiptsToFolder: receiptIds => ipcRenderer.invoke("copy-receipts-to-folder", receiptIds),
  zipReceipts: receiptIds => ipcRenderer.invoke("zip-receipts", receiptIds),
  shareReceipts: receiptIds => ipcRenderer.invoke("share-receipts", receiptIds),
  openCostcoSyncBrowser: options => ipcRenderer.invoke("open-costco-sync-browser", options),
  openProductBrowser: item => ipcRenderer.invoke("open-product-browser", item),
  findCostcoProduct: item => ipcRenderer.invoke("find-costco-product", item),
  extractProductMetadata: productUrl => ipcRenderer.invoke("extract-product-metadata", productUrl),
  onProductMetadataSaved: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("product-metadata-saved", listener);
    return () => ipcRenderer.removeListener("product-metadata-saved", listener);
  },
  onReceiptSyncProgress: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("receipt-sync-progress", listener);
    return () => ipcRenderer.removeListener("receipt-sync-progress", listener);
  }
});
