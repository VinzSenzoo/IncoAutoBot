import "dotenv/config";
import blessed from "blessed";
import figlet from "figlet";
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const USDC_ADDRESS = process.env.USDC_ADDRESS;
const CUSDC_ADDRESS = process.env.CUSDC_ADDRESS;
const NETWORK_NAME = "Base Sepolia";
const DEBUG_MODE = false;

const ERC20ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function mint(address _to, uint256 _amount)",
  "function wrap(uint256 tokenID_)",
  "function unwrap(uint256 tokenID_)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, bytes data)"
];

let walletInfo = {
  address: "",
  balanceNative: "0.00",
  balanceUsdc: "0.00",
  network: NETWORK_NAME,
  status: "Initializing"
};

let transactionLogs = [];
let incoToolRunning = false;
let incoToolCancelled = false;
let globalWallet = null;
let provider = null;
let transactionQueue = Promise.resolve();
let transactionQueueList = [];
let transactionIdCounter = 0;
let nextNonce = null;

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function getShortHash(hash) {
  if (!hash || typeof hash !== "string" || hash === "0x") {
    return "Invalid Hash";
  }
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function addLog(message, type) {
  if (type === "debug" && !DEBUG_MODE) return;
  const timestamp = new Date().toLocaleTimeString();
  let coloredMessage = message;
  if (type === "inco") coloredMessage = `{bright-cyan-fg}${message}{/bright-cyan-fg}`;
  else if (type === "system") coloredMessage = `{bright-white-fg}${message}{/bold}{/bright-white-fg}`;
  else if (type === "error") coloredMessage = `{bright-red-fg}${message}{/bold}{/bright-red-fg}`;
  else if (type === "success") coloredMessage = `{bright-green-fg}${message}{/bold}{/bright-green-fg}`;
  else if (type === "warning") coloredMessage = `{bright-yellow-fg}${message}{/bold}{/bright-yellow-fg}`;
  else if (type === "debug") coloredMessage = `{bright-magenta-fg}${message}{/bold}{/bright-magenta-fg}`;

  transactionLogs.push(`{bright-cyan-fg}[{/bright-cyan-fg} {bold}{grey-fg}${timestamp}{/grey-fg}{/bold} {bright-cyan-fg}]{/bright-cyan-fg} {bold}${coloredMessage}{/bold}`);
  updateLogs();
}

function updateLogs() {
  logsBox.setContent(transactionLogs.join("\n"));
  logsBox.setScrollPerc(100);
  safeRender();
}

function clearTransactionLogs() {
  transactionLogs = [];
  logsBox.setContent("");
  logsBox.setScroll(0);
  updateLogs();
  safeRender();
  addLog("Transaction logs telah dihapus.", "system");
}

async function addTransactionToQueue(transactionFunction, description = "Transaksi") {
  const transactionId = ++transactionIdCounter;
  transactionQueueList.push({
    id: transactionId,
    description,
    timestamp: new Date().toLocaleTimeString(),
    status: "queued"
  });
  addLog(`Transaksi [${transactionId}] ditambahkan ke antrean: ${description}`, "system");
  updateQueueDisplay();

  transactionQueue = transactionQueue.then(async () => {
    updateTransactionStatus(transactionId, "processing");
    try {
      if (nextNonce === null) {
        nextNonce = await provider.getTransactionCount(globalWallet.address, "pending");
        addLog(`Nonce awal: ${nextNonce}`, "debug");
      }
      const tx = await transactionFunction(nextNonce);
      const txHash = tx.hash;
      const receipt = await tx.wait();
      nextNonce++;
      if (receipt.status === 1) {
        updateTransactionStatus(transactionId, "completed");
        addLog(`Transaksi [${transactionId}] Selesai. Hash: ${getShortHash(receipt.transactionHash || txHash)}`, "debug");
        if (description.includes("Mint") || description.includes("Shield") || description.includes("Unshield")) {
          const token = description.includes("USDC") ? "USDC" : description.includes("cUSDC") ? "cUSDC" : "USDC/cUSDC";
          addLog(`${description} selesai Tx hash: ${getShortHash(receipt.transactionHash || txHash)}`, "success");
        }
        await updateWalletData();
      } else {
        updateTransactionStatus(transactionId, "failed");
        addLog(`Transaksi [${transactionId}] gagal: Transaksi ditolak oleh kontrak.`, "error");
      }
      return { receipt, txHash, tx };
    } catch (error) {
      updateTransactionStatus(transactionId, "error");
      let errorMessage = error.message;
      if (error.code === "CALL_EXCEPTION") {
        errorMessage = `Transaksi ditolak oleh kontrak: ${error.reason || "Alasan tidak diketahui"}`;
      }
      addLog(`Transaksi [${transactionId}] gagal: ${errorMessage}`, "error");
      if (error.message.includes("nonce has already been used")) {
        nextNonce++;
        addLog(`Nonce diincrement karena sudah digunakan. Nilai nonce baru: ${nextNonce}`, "system");
      }
      return null;
    } finally {
      removeTransactionFromQueue(transactionId);
      updateQueueDisplay();
    }
  });
  return transactionQueue;
}

function updateTransactionStatus(id, status) {
  transactionQueueList.forEach(tx => {
    if (tx.id === id) tx.status = status;
  });
  updateQueueDisplay();
}

function removeTransactionFromQueue(id) {
  transactionQueueList = transactionQueueList.filter(tx => tx.id !== id);
  updateQueueDisplay();
}

function getTransactionQueueContent() {
  if (transactionQueueList.length === 0) return "Tidak ada transaksi dalam antrean.";
  return transactionQueueList
    .map(tx => `ID: ${tx.id} | ${tx.description} | ${tx.status} | ${tx.timestamp}`)
    .join("\n");
}

let queueMenuBox = null;
let queueUpdateInterval = null;

function showTransactionQueueMenu() {
  const container = blessed.box({
    label: " Antrian Transaksi ",
    top: "10%",
    left: "center",
    width: "80%",
    height: "80%",
    border: { type: "line" },
    style: { border: { fg: "blue" } },
    keys: true,
    mouse: true,
    interactive: true
  });
  const contentBox = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: "90%",
    content: getTransactionQueueContent(),
    scrollable: true,
    keys: true,
    mouse: true,
    alwaysScroll: true,
    scrollbar: { ch: " ", inverse: true, style: { bg: "blue" } }
  });
  const exitButton = blessed.button({
    content: " [Keluar] ",
    bottom: 0,
    left: "center",
    shrink: true,
    padding: { left: 1, right: 1 },
    style: { fg: "white", bg: "red", hover: { bg: "blue" } },
    mouse: true,
    keys: true,
    interactive: true
  });
  exitButton.on("press", () => {
    addLog("Keluar Dari Menu Antrian Transaksi.", "system");
    clearInterval(queueUpdateInterval);
    container.destroy();
    queueMenuBox = null;
    mainMenu.show();
    mainMenu.focus();
    screen.render();
  });
  container.key(["a", "s", "d"], () => {
    addLog("Keluar Dari Menu Antrian Transaksi.", "system");
    clearInterval(queueUpdateInterval);
    container.destroy();
    queueMenuBox = null;
    mainMenu.show();
    mainMenu.focus();
    screen.render();
  });
  container.append(contentBox);
  container.append(exitButton);
  queueUpdateInterval = setInterval(() => {
    contentBox.setContent(getTransactionQueueContent());
    screen.render();
  }, 1000);
  mainMenu.hide();
  screen.append(container);
  container.focus();
  screen.render();
}

function updateQueueDisplay() {
  if (queueMenuBox) {
    queueMenuBox.setContent(getTransactionQueueContent());
    screen.render();
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "Inco Tool",
  fullUnicode: true,
  mouse: true
});

let renderTimeout;

function safeRender() {
  if (renderTimeout) clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => { screen.render(); }, 50);
}

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  tags: true,
  style: { fg: "white", bg: "default" }
});

figlet.text("NT EXHAUST".toUpperCase(), { font: "ANSI Shadow", horizontalLayout: "default" }, (err, data) => {
  if (err) headerBox.setContent("{center}{bold}NT Exhaust{/bold}{/center}");
  else headerBox.setContent(`{center}{bold}{bright-cyan-fg}${data}{/bright-cyan-fg}{/bold}{/center}`);
  safeRender();
});

const descriptionBox = blessed.box({
  left: "center",
  width: "100%",
  content: "{center}{bold}{bright-yellow-fg}✦ ✦ INCO AUTO BOT ✦ ✦{/bright-yellow-fg}{/bold}{/center}",
  tags: true,
  style: { fg: "white", bg: "default" }
});

const logsBox = blessed.box({
  label: " Transaction Logs ",
  left: 0,
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  style: { border: { fg: "red" }, fg: "white" },
  scrollbar: { ch: " ", inverse: true, style: { bg: "blue" } },
  content: ""
});

const walletBox = blessed.box({
  label: " Informasi Wallet ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "magenta" }, fg: "white", bg: "default" },
  content: "Loading data wallet..."
});

const mainMenu = blessed.list({
  label: " Menu ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "green", fg: "black" } },
  items: getMainMenuItems()
});

function getIncoToolMenuItems() {
  let items = [];
  if (incoToolRunning) items.push("Stop Transaction");
  items = items.concat([
    "Auto Mint USDC",
    "Auto Mint cUSDC",
    "Shield USDC",
    "Unshield USDC",
    "Clear Transaction Logs",
    "Back To Main Menu",
    "Refresh"
  ]);
  return items;
}

const incoToolSubMenu = blessed.list({
  label: " Inco Tool Sub Menu ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "cyan", fg: "black" } },
  items: getIncoToolMenuItems()
});
incoToolSubMenu.hide();

screen.append(headerBox);
screen.append(descriptionBox);
screen.append(logsBox);
screen.append(walletBox);
screen.append(mainMenu);
screen.append(incoToolSubMenu);

function adjustLayout() {
  const screenHeight = screen.height;
  const screenWidth = screen.width;
  const headerHeight = Math.max(8, Math.floor(screenHeight * 0.15));
  headerBox.top = 0;
  headerBox.height = headerHeight;
  headerBox.width = "100%";
  descriptionBox.top = "22%";
  descriptionBox.height = Math.floor(screenHeight * 0.05);
  logsBox.top = headerHeight + descriptionBox.height;
  logsBox.left = 0;
  logsBox.width = Math.floor(screenWidth * 0.6);
  logsBox.height = screenHeight - (headerHeight + descriptionBox.height);
  walletBox.top = headerHeight + descriptionBox.height;
  walletBox.left = Math.floor(screenWidth * 0.6);
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  mainMenu.top = headerHeight + descriptionBox.height + walletBox.height;
  mainMenu.left = Math.floor(screenWidth * 0.6);
  mainMenu.width = Math.floor(screenWidth * 0.4);
  mainMenu.height = screenHeight - (headerHeight + descriptionBox.height + walletBox.height);
  incoToolSubMenu.top = mainMenu.top;
  incoToolSubMenu.left = mainMenu.left;
  incoToolSubMenu.width = mainMenu.width;
  incoToolSubMenu.height = mainMenu.height;
  safeRender();
}

screen.on("resize", adjustLayout);
adjustLayout();

async function getTokenBalance(tokenAddress) {
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20ABI, provider);
    const balance = await contract.balanceOf(globalWallet.address);
    const decimals = await contract.decimals();
    return ethers.formatUnits(balance, decimals || 18);
  } catch (error) {
    addLog(`Gagal mengambil saldo token ${tokenAddress}: ${error.message}`, "error");
    return "0";
  }
}

async function updateWalletData() {
  try {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    globalWallet = wallet;
    walletInfo.address = wallet.address;

    const nativeBalance = await provider.getBalance(wallet.address);
    walletInfo.balanceNative = ethers.formatEther(nativeBalance);
    walletInfo.balanceUsdc = await getTokenBalance(USDC_ADDRESS);

    addLog(`Saldo ETH: ${walletInfo.balanceNative}`, "debug");
    addLog(`Saldo USDC: ${walletInfo.balanceUsdc}`, "debug");

    updateWallet();
    addLog("Saldo & Wallet Updated !!", "system");
  } catch (error) {
    addLog("Gagal mengambil data wallet: " + error.message, "system");
  }
}

function updateWallet() {
  const shortAddress = walletInfo.address ? getShortAddress(walletInfo.address) : "N/A";
  const native = walletInfo.balanceNative ? Number(walletInfo.balanceNative).toFixed(4) : "0.0000";
  const usdc = walletInfo.balanceUsdc ? Number(walletInfo.balanceUsdc).toFixed(2) : "0.00";

  const content = `┌── Address   : {bright-yellow-fg}${shortAddress}{/bright-yellow-fg}
│   ├── ETH Native : {bright-green-fg}${native}{/bright-green-fg}
│   ├── USDC       : {bright-green-fg}${usdc}{/bright-green-fg}
└── Network        : {bright-cyan-fg}${NETWORK_NAME}{/bright-cyan-fg}`;
  walletBox.setContent(content);
  safeRender();
}

async function getTokenAmount(tokenName, action, callback) {
  addLog(`Membuat form input untuk jumlah ${tokenName} (${action})`, "debug");

  const formBox = blessed.form({
    parent: screen,
    top: "center",
    left: "center",
    width: "50%",
    height: 8,
    border: { type: "line" },
    style: { border: { fg: "cyan" }, fg: "white", bg: "default" },
    keys: true,
    mouse: true,
    label: ` Input Jumlah ${tokenName} (${action}) `
  });

  const label = blessed.text({
    parent: formBox,
    top: 1,
    left: 2,
    content: `Masukkan jumlah ${tokenName} (misalnya, 100):`,
    style: { fg: "white" }
  });

  const input = blessed.textbox({
    parent: formBox,
    top: 2,
    left: 2,
    width: "90%",
    height: 1,
    inputOnFocus: true,
    style: { fg: "white", bg: "blue" },
    keys: true
  });

  const okButton = blessed.button({
    parent: formBox,
    top: 4,
    left: 2,
    width: 10,
    height: 1,
    content: "OK",
    style: { fg: "white", bg: "green", hover: { bg: "darkgreen" } },
    mouse: true,
    keys: true
  });

  const cancelButton = blessed.button({
    parent: formBox,
    top: 4,
    left: 14,
    width: 10,
    height: 1,
    content: "Cancel",
    style: { fg: "white", bg: "red", hover: { bg: "darkred" } },
    mouse: true,
    keys: true
  });

  mainMenu.hide();
  screen.append(formBox);

  const submitForm = () => {
    const value = input.getValue().trim();
    addLog(`Form disubmit, input: ${value}`, "debug");
    formBox.destroy();
    incoToolSubMenu.focus();
    safeRender();
    const amount = parseFloat(value);
    if (isNaN(amount) || amount <= 0) {
      addLog(`Jumlah ${tokenName} tidak valid. Harap masukkan angka.`, "error");
      callback(new Error("Invalid amount"));
      return;
    }
    callback(null, amount);
  };

  input.key(["enter"], submitForm);
  okButton.on("press", submitForm);

  cancelButton.on("press", () => {
    addLog(`Cancel ditekan untuk form ${tokenName} (${action})`, "debug");
    formBox.destroy();
    incoToolSubMenu.focus();
    safeRender();
    callback(new Error("Input cancelled"));
  });

  formBox.key(["escape"], () => {
    addLog(`Escape ditekan untuk form ${tokenName} (${action})`, "debug");
    formBox.destroy();
    incoToolSubMenu.focus();
    safeRender();
    callback(new Error("Input cancelled"));
  });

  input.focus();
  safeRender();
}

async function performUsdcMint(amount) {
  try {
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20ABI, globalWallet);
    const mintAmount = ethers.parseUnits(amount.toString(), 18);
    addLog(`Memulai proses mint ${amount} USDC`, "inco");
    const tx = await usdcContract.mint(globalWallet.address, mintAmount);
    addLog(`Tx Mint Sent.. Hash: ${getShortHash(tx.hash)}`, "inco");
    return tx;
  } catch (error) {
    throw new Error(`Gagal mint USDC: ${error.message}`);
  }
}

async function performCusdcMint(amount) {
  try {
    const cusdcContract = new ethers.Contract(CUSDC_ADDRESS, ERC20ABI, globalWallet);
    const mintAmount = ethers.parseUnits(amount.toString(), 18);
    addLog(`Memulai proses mint ${amount} cUSDC`, "inco");
    const tx = await cusdcContract.mint(globalWallet.address, mintAmount);
    addLog(`Tx Mint Sent.. Hash: ${getShortHash(tx.hash)}`, "inco");
    return tx;
  } catch (error) {
    throw new Error(`Gagal mint cUSDC: ${error.message}`);
  }
}

async function secureUsdc(amount) {
  try {
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20ABI, globalWallet);
    const cusdcContract = new ethers.Contract(CUSDC_ADDRESS, ERC20ABI, globalWallet);
    const secureAmount = ethers.parseUnits(amount.toString(), 18);

    addLog(`Memulai proses SHIELD ${amount} USDC ➯ cUSDC...`, "inco");
    const approveTx = await usdcContract.approve(CUSDC_ADDRESS, secureAmount);
    addLog(`SHIELD USDC Approved`, "success");
    await approveTx.wait();

    addLog(`SHIELD ${amount} USDC ➯  cUSDC...`, "inco");
    const tx = await cusdcContract.wrap(secureAmount);
    addLog(`SHIELD USDC Done. Hash: ${getShortHash(tx.hash)}`, "success");
    return tx;
  } catch (error) {
    throw new Error(`Gagal shield USDC: ${error.message}`);
  }
}

async function releaseUsdc(amount) {
  try {
    const cusdcContract = new ethers.Contract(CUSDC_ADDRESS, ERC20ABI, globalWallet);
    const releaseAmount = ethers.parseUnits(amount.toString(), 18);
    addLog(`Memulai proses UNSHIELD ${amount} cUSDC ➯ USDC...`, "inco");
    const tx = await cusdcContract.unwrap(releaseAmount);
    addLog(`UNSHIELD cUSDC Done. Hash: ${getShortHash(tx.hash)}`, "success");
    return tx;
  } catch (error) {
    throw new Error(`Gagal unshield USDC: ${error.message}`);
  }
}

async function autoMintUsdc() {
  return new Promise((resolve) => {
    getTokenAmount("USDC", "Mint", (err, amount) => {
      if (err) {
        addLog(`Proses mint USDC dibatalkan: ${err.message}`, "warning");
        resolve();
        return;
      }
      addTransactionToQueue(
        async () => performUsdcMint(amount),
        `Mint ${amount} USDC`
      ).then(resolve);
    });
  });
}

async function autoMintCusdc() {
  return new Promise((resolve) => {
    getTokenAmount("cUSDC", "Mint", (err, amount) => {
      if (err) {
        addLog(`Proses mint cUSDC dibatalkan: ${err.message}`, "warning");
        resolve();
        return;
      }
      addTransactionToQueue(
        async () => performCusdcMint(amount),
        `Mint ${amount} cUSDC`
      ).then(resolve);
    });
  });
}

async function autoSecureUsdc() {
  return new Promise((resolve) => {
    getTokenAmount("USDC", "Shield", (err, amount) => {
      if (err) {
        addLog(`Proses shield USDC dibatalkan: ${err.message}`, "warning");
        resolve();
        return;
      }
      addTransactionToQueue(
        async () => secureUsdc(amount),
        `Shield ${amount} USDC`
      ).then(resolve);
    });
  });
}

async function autoReleaseUsdc() {
  return new Promise((resolve) => {
    getTokenAmount("cUSDC", "Unshield", (err, amount) => {
      if (err) {
        addLog(`Proses unshield cUSDC dibatalkan: ${err.message}`, "warning");
        resolve();
        return;
      }
      addTransactionToQueue(
        async () => releaseUsdc(amount),
        `Unshield ${amount} cUSDC`
      ).then(resolve);
    });
  });
}

async function runAutoMintUsdc() {
  if (incoToolRunning) {
    addLog("Transaksi sedang berjalan. Hentikan transaksi terlebih dahulu.", "warning");
    return;
  }
  incoToolRunning = true;
  incoToolCancelled = false;
  addLog("Inco Tool: Memulai Auto Mint USDC.", "inco");
  await autoMintUsdc();
  incoToolRunning = false;
}

async function runAutoMintCusdc() {
  if (incoToolRunning) {
    addLog("Transaksi sedang berjalan. Hentikan transaksi terlebih dahulu.", "warning");
    return;
  }
  incoToolRunning = true;
  incoToolCancelled = false;
  addLog("Inco Tool: Memulai Auto Mint cUSDC.", "inco");
  await autoMintCusdc();
  incoToolRunning = false;
}

async function executeSecureUsdc() {
  if (incoToolRunning) {
    addLog("Transaksi Inco Tool sedang berjalan. Hentikan transaksi terlebih dahulu.", "warning");
    return;
  }
  incoToolRunning = true;
  incoToolCancelled = false;
  addLog("Inco Tool: Memulai Shield USDC.", "inco");
  await autoSecureUsdc();
  incoToolRunning = false;
}

async function executeReleaseUsdc() {
  if (incoToolRunning) {
    addLog("Transaksi Inco Tool sedang berjalan. Hentikan transaksi terlebih dahulu.", "warning");
    return;
  }
  incoToolRunning = true;
  incoToolCancelled = false;
  addLog("Inco Tool: Memulai Unshield USDC.", "inco");
  await autoReleaseUsdc();
  incoToolRunning = false;
}

function getMainMenuItems() {
  let items = [];
  if (incoToolRunning) items.push("Stop All Transactions");
  items = items.concat(["Inco Tool", "Antrian Transaksi", "Clear Transaction Logs", "Refresh", "Exit"]);
  return items;
}

function stopAllTransactions() {
  if (incoToolRunning) {
    incoToolCancelled = true;
    addLog("Stop All Transactions: Semua transaksi akan dihentikan.", "system");
  }
}

mainMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Inco Tool") {
    mainMenu.hide();
    incoToolSubMenu.show();
    incoToolSubMenu.focus();
    safeRender();
  } else if (selected === "Antrian Transaksi") {
    showTransactionQueueMenu();
  } else if (selected === "Stop All Transactions") {
    stopAllTransactions();
    mainMenu.setItems(getMainMenuItems());
    mainMenu.focus();
    safeRender();
  } else if (selected === "Clear Transaction Logs") {
    clearTransactionLogs();
  } else if (selected === "Refresh") {
    updateWalletData();
    safeRender();
    addLog("Refreshed", "system");
  } else if (selected === "Exit") {
    process.exit(0);
  }
});

incoToolSubMenu.on("select", async (item, index) => {
  const selected = item.getText();
  addLog(`Opsi submenu dipilih: ${selected}`, "debug");
  if (selected === "Auto Mint USDC") {
    await runAutoMintUsdc();
    incoToolSubMenu.select(index);
    incoToolSubMenu.focus();
    safeRender();
  } else if (selected === "Auto Mint cUSDC") {
    await runAutoMintCusdc();
    incoToolSubMenu.select(index);
    incoToolSubMenu.focus();
    safeRender();
  } else if (selected === "Shield USDC") {
    await executeSecureUsdc();
    incoToolSubMenu.select(index);
    incoToolSubMenu.focus();
    safeRender();
  } else if (selected === "Unshield USDC") {
    await executeReleaseUsdc();
    incoToolSubMenu.select(index);
    incoToolSubMenu.focus();
    safeRender();
  } else if (selected === "Stop Transaction") {
    if (incoToolRunning) {
      incoToolCancelled = true;
      addLog("Inco Tool: Perintah Stop Transaction diterima.", "inco");
    } else {
      addLog("Inco Tool: Tidak ada transaksi yang berjalan.", "inco");
    }
    incoToolSubMenu.select(index);
    incoToolSubMenu.focus();
    safeRender();
  } else if (selected === "Clear Transaction Logs") {
    clearTransactionLogs();
    incoToolSubMenu.select(index);
    incoToolSubMenu.focus();
    safeRender();
  } else if (selected === "Back To Main Menu") {
    incoToolSubMenu.hide();
    mainMenu.show();
    mainMenu.focus();
    safeRender();
  } else if (selected === "Refresh") {
    updateWalletData();
    incoToolSubMenu.select(index);
    incoToolSubMenu.focus();
    safeRender();
    addLog("Refreshed", "system");
  }
});

screen.key(["escape", "q", "C-c"], () => process.exit(0));
screen.key(["C-up"], () => { logsBox.scroll(-1); safeRender(); });
screen.key(["C-down"], () => { logsBox.scroll(1); safeRender(); });

safeRender();
mainMenu.focus();
addLog("Dont Forget To Subscribe YT And Telegram @NTExhaust!!", "system");
updateWalletData();
