const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const csv = require("csv-parser");

// Configuration
const CONFIG = {
  delayBetweenRequests: 1000,
  maxRetries: 3, // Increased retries
  dataDir: path.join(__dirname, "data"),
  outputFile: "tireData.xlsx",
  jsonOutputFile: "tireData.json",
  urlsFile: "filtered_product2.xlsx",
  urlColumn: "Address",
  successFile: "success.json",
  failedFile: "failed.json",
  requestTimeout: 30000, // 30 seconds timeout
};

// Initialize data directory and files
function initializeFiles() {
  if (!fs.existsSync(CONFIG.dataDir)) {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  }

  [CONFIG.successFile, CONFIG.failedFile].forEach((file) => {
    const filePath = path.join(CONFIG.dataDir, file);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, "[]");
    }
  });
}

// Load URLs from file
async function loadUrls() {
  try {
    let filePath = path.join(CONFIG.dataDir, CONFIG.urlsFile);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(__dirname, CONFIG.urlsFile);
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(
        `File not found at:\n- ${path.join(
          CONFIG.dataDir,
          CONFIG.urlsFile
        )}\n- ${path.join(__dirname, CONFIG.urlsFile)}`
      );
    }

    const fileExt = path.extname(filePath).toLowerCase();
    let urls = [];

    if (fileExt === ".xlsx") {
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet);

      const urlColumn = Object.keys(jsonData[0] || {}).find(
        (key) => key.toLowerCase() === CONFIG.urlColumn.toLowerCase()
      );

      if (!urlColumn) {
        throw new Error(`Column "${CONFIG.urlColumn}" not found in Excel file`);
      }

      urls = jsonData
        .map((row) => row[urlColumn])
        .filter((url) => url && typeof url === "string")
        .map((url) => url.trim())
        .filter((url) => url !== "" && url.startsWith("http"));
    } else if (fileExt === ".csv") {
      urls = await new Promise((resolve) => {
        const results = [];
        fs.createReadStream(filePath)
          .pipe(csv())
          .on("data", (row) => {
            const url =
              row[CONFIG.urlColumn] ||
              Object.values(row).find((val) => val?.startsWith("http"));
            if (url && url.startsWith("http")) {
              results.push(url.trim());
            }
          })
          .on("end", () => resolve(results))
          .on("error", (error) => {
            console.error("CSV parsing error:", error);
            resolve([]);
          });
      });
    } else {
      throw new Error("Unsupported file format. Please use .xlsx or .csv");
    }

    if (urls.length === 0) {
      throw new Error("No valid URLs found in the specified column");
    }

    return urls;
  } catch (error) {
    console.error("Error loading URLs:", error.message);
    return [];
  }
}

// Load processed URLs
function loadProcessedUrls(filename) {
  const filePath = path.join(CONFIG.dataDir, filename);
  try {
    const content = fs.readFileSync(filePath, "utf8").trim();
    return content ? JSON.parse(content) : [];
  } catch (error) {
    console.error(`Error loading ${filename}:`, error.message);
    return [];
  }
}

// Save progress to file
function saveProgress(url, filename) {
  const filePath = path.join(CONFIG.dataDir, filename);
  try {
    const processedUrls = loadProcessedUrls(filename);
    if (!processedUrls.includes(url)) {
      processedUrls.push(url);
      fs.writeFileSync(filePath, JSON.stringify(processedUrls, null, 2));
    }
  } catch (error) {
    console.error(`Error saving to ${filename}:`, error.message);
  }
}

// Scrape single URL with retries
async function scrapeUrl(url, retryCount = 0) {
  try {
    console.log(`Attempt ${retryCount + 1} for ${url}`);

    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: CONFIG.requestTimeout,
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status} received`);
    }

    const $ = cheerio.load(response.data);
    const tireData = scrapeTireData($, url);

    // Validate we got essential data
    if (!tireData.name || !tireData.sizeNo) {
      throw new Error("Essential data (name/size) not found on page");
    }

    return tireData;
  } catch (error) {
    if (retryCount < CONFIG.maxRetries) {
      const delay = 2000 * (retryCount + 1); // Exponential backoff
      console.log(
        `Retrying ${url} in ${delay}ms (${retryCount + 1}/${CONFIG.maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return scrapeUrl(url, retryCount + 1);
    }
    throw error;
  }
}

// Scrape tire data from page
function scrapeTireData($, url) {
  const getText = (selector, defaultValue = "") => {
    try {
      const result = $(selector).text().trim();
      return result || defaultValue;
    } catch {
      return defaultValue;
    }
  };

  const getAttribute = (selector, attr, defaultValue = "") => {
    try {
      const result = $(selector).attr(attr);
      return result || defaultValue;
    } catch {
      return defaultValue;
    }
  };

  // Multiple selector fallbacks for critical fields
  const name =
    $("h1[data-ui-id='page-title-wrapper']")
      .clone()
      .children()
      .remove()
      .end()
      .text()
      .trim() ||
    $("h1.product-name").text().trim() ||
    $("h1").first().text().trim();

  const sizeNo =
    getText("span.size_no") ||
    getText(".tire-size") ||
    getText(".product-size");

  // Price extraction with multiple fallbacks
  const price =
    $('span[id^="product-price-"]').first().text().trim() ||
    $(".price-final").text().trim() ||
    $(".regular-price").text().trim();

  const tireData = {
    url: url,
    name: name,
    sizeNo: sizeNo,
    price: price,
    setprice: getText("div.set_price span.price"),
    serviceDesc: getText(".serv_desc").replace("Serv. Desc:", ""),
    Country: $(".menufacture_country").text().replace("Country:", "").trim(),
    UTQG: $("span.utqg_val")
      .map(function () {
        return $(this)
          .text()
          .replace(/&nbsp;/g, "")
          .trim();
      })
      .get()
      .join(" "),
    manufactureYear: $('div[title="Year of manufacture"]')
      .text()
      .split(":")[1]
      .trim(),
    wheelColor: $('span:contains("Sidewall Style:")')
      .parent()
      .text()
      .replace("Sidewall Style:", "")
      .trim(),
    description: $("div.detail_descrption")
      .contents()
      .filter((_, el) => el.nodeType === 3)
      .text()
      .trim(),
    title: getText("div.detail_descrption h2.title"),
    rating: $("div.driverreviews-widget_rating-value").text().trim(),
    skuId: getText("div.pro_size_detail span.sku"),
    logo: getAttribute("div.brand img.img-responsive", "src"),
    tyreImage: getAttribute(
      "div.product_thumbnail_container img.img-responsive",
      "src"
    ),
    specifications: [],
  };

  $("div.product_detail_right tr").each((i, row) => {
    const label = $(row).find("td").first().text().trim();
    const value = $(row).find("td").last().text().trim();
    if (label && value) {
      tireData.specifications.push({ label, value });
    }
  });

  return tireData;
}

// Load existing data
function loadExistingData() {
  const jsonPath = path.join(CONFIG.dataDir, CONFIG.jsonOutputFile);
  try {
    if (fs.existsSync(jsonPath)) {
      const content = fs.readFileSync(jsonPath, "utf8").trim();
      return content ? JSON.parse(content) : [];
    }
  } catch (error) {
    console.error("Error loading existing data:", error.message);
  }
  return [];
}

// Save data to both JSON and Excel
async function saveData(newData, finalSave = false) {
  try {
    // Load existing data
    const existingData = loadExistingData();
    const existingUrls = new Set(existingData.map((item) => item.url));

    // Merge data
    const mergedData = [...existingData];
    for (const newItem of newData) {
      if (!existingUrls.has(newItem.url)) {
        mergedData.push(newItem);
        existingUrls.add(newItem.url); // Prevent duplicates
      }
    }

    // Save to JSON
    const jsonPath = path.join(CONFIG.dataDir, CONFIG.jsonOutputFile);
    fs.writeFileSync(jsonPath, JSON.stringify(mergedData, null, 2));

    // Save to Excel if final save or every 50 records
    if (finalSave || mergedData.length % 50 === 0) {
      const excelData = mergedData.map((item) => ({
        URL: item.url,
        "Product Name": item.name,
        "Size No": item.sizeNo,
        Price: item.price,
        "Set Price": item.setprice,
        "Service Description": item.serviceDesc,
        Country: item.Country,
        UTQG: item.UTQG,
        "Manufacture Year": item.manufactureYear,
        "Wheel Color": item.wheelColor,
        Description: item.description,
        Title: item.title,
        Rating: item.rating,
        "SKU ID": item.skuId,
        "Logo URL": item.logo,
        "Tire Image": item.tyreImage,
        Specifications: item.specifications
          .map((spec) => `${spec.label}: ${spec.value}`)
          .join(" | "),
      }));

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(excelData);
      XLSX.utils.book_append_sheet(workbook, worksheet, "Tire Data");

      // Save to temporary file first
      const tempFile = path.join(__dirname, "temp_tireData.xlsx");
      XLSX.writeFile(workbook, tempFile);

      // Then rename (atomic operation)
      fs.renameSync(tempFile, CONFIG.outputFile);
    }

    console.log(
      `✅ Saved ${mergedData.length} records (${newData.length} new)`
    );
  } catch (error) {
    console.error("Error saving output files:", error.message);
  }
}

// Main scraper function
async function runScraper() {
  console.log("🚀 Starting scraper...");
  initializeFiles();

  try {
    const urls = await loadUrls();
    if (urls.length === 0) {
      throw new Error("No URLs found to process");
    }

    const successUrls = loadProcessedUrls(CONFIG.successFile);
    const failedUrls = loadProcessedUrls(CONFIG.failedFile);
    const uniqueUrls = [...new Set(urls)];
    const urlsToProcess = uniqueUrls.filter(
      (url) => !successUrls.includes(url) && !failedUrls.includes(url)
    );

    console.log(`
📊 Statistics:
  Total URLs: ${urls.length}
  Already processed: ${successUrls.length}
  Previously failed: ${failedUrls.length}
  New URLs to process: ${urlsToProcess.length}
    `);

    if (urlsToProcess.length === 0) {
      console.log("✅ No new URLs to process");
      return;
    }

    const newTireData = [];
    for (const [index, url] of urlsToProcess.entries()) {
      console.log(`🔄 Processing ${index + 1}/${urlsToProcess.length}: ${url}`);
      let attempts = 0;
      let success = false;

      while (attempts < CONFIG.maxRetries && !success) {
        attempts++;
        try {
          const tireData = await scrapeUrl(url);

          if (!tireData.name || !tireData.sizeNo) {
            throw new Error("Incomplete data received");
          }

          newTireData.push(tireData);
          saveProgress(url, CONFIG.successFile);
          success = true;

          // Save after every successful scrape
          await saveData(newTireData);
        } catch (error) {
          console.error(
            `❌ Attempt ${attempts} failed for ${url}:`,
            error.message
          );

          if (attempts >= CONFIG.maxRetries) {
            console.error(`⚠️ Giving up on ${url} after ${attempts} attempts`);
            saveProgress(url, CONFIG.failedFile);
          } else {
            const delay = 3000 * attempts;
            console.log(`Waiting ${delay}ms before retry...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      // Normal delay between URLs if successful
      if (success && index < urlsToProcess.length - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, CONFIG.delayBetweenRequests)
        );
      }
    }

    // Final save
    if (newTireData.length > 0) {
      await saveData(newTireData, true);
      const existingData = loadExistingData();
      console.log(`
🎉 Scraping completed!
  New records added: ${newTireData.length}
  Total records now: ${existingData.length}
  Failed URLs: ${failedUrls.length}
  Output files updated:
    - ${path.join(CONFIG.dataDir, CONFIG.jsonOutputFile)}
    - ${CONFIG.outputFile}
      `);
    } else {
      console.log("⚠️ No new data was scraped");
    }
  } catch (error) {
    console.error("💥 Fatal scraper error:", error.message);
  } finally {
    console.log("Scraping completed");
  }
}

// Start the scraper
runScraper();
