const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const xml2js = require("xml2js");
const parser = new xml2js.Parser();

// Configuration
const CONFIG = {
  delayBetweenRequests: 2000,
  maxRetries: 3,
  maxRetriesForNonMatches: 1,
  dataDir: path.join(__dirname, "data"),
  outputFile: path.join(__dirname, "tireData.xlsx"),
  jsonOutputFile: path.join(__dirname, "tireData.json"),
  sitemapUrl: "https://www.pitstoparabia.com/sitemap.xml",
  successFile: path.join(__dirname, "success.json"),
  failedFile: path.join(__dirname, "failed.json"),
  nonMatchFile: path.join(__dirname, "nonmatch.json"),
  requestTimeout: 30000,
  targetDomains: ["www.pitstoparabia.com"],
  // targetPathPatterns: ["/tyres/"],
  maxConcurrentRequests: 5,
  saveInterval: 5, // Save progress every 5 URLs
};

// Initialize files
function initializeFiles() {
  if (!fs.existsSync(CONFIG.dataDir)) {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  }

  [CONFIG.successFile, CONFIG.failedFile, CONFIG.nonMatchFile].forEach(
    (file) => {
      try {
        if (!fs.existsSync(file)) {
          fs.writeFileSync(file, "[]");
        }
      } catch (error) {
        console.error(`Error initializing ${file}:`, error.message);
      }
    }
  );
}

// Check if URL matches our target patterns
function isTargetUrl(url) {
  try {
    const urlObj = new URL(url);
    const isCorrectDomain = CONFIG.targetDomains.includes(urlObj.hostname);
    // const hasTargetPath = CONFIG.targetPathPatterns.some((pattern) =>
    //   urlObj.pathname.includes(pattern)
    // );
    return isCorrectDomain 
  } catch {
    return false;
  }
}

// Fetch and parse sitemap URLs
async function fetchSitemapUrls() {
  try {
    console.log(`Fetching sitemap from ${CONFIG.sitemapUrl}`);
    const response = await axios.get(CONFIG.sitemapUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: CONFIG.requestTimeout,
    });

    const result = await parser.parseStringPromise(response.data);
    const urls = [];

    if (result.urlset && result.urlset.url) {
      for (const urlObj of result.urlset.url) {
        if (urlObj.loc && urlObj.loc[0]) {
          urls.push(urlObj.loc[0].trim());
        }
      }
    }

    if (urls.length === 0) {
      throw new Error("No URLs found in sitemap");
    }

    console.log(`Found ${urls.length} URLs in sitemap`);
    return urls;
  } catch (error) {
    console.error("Error fetching sitemap:", error.message);
    return [];
  }
}

// Load processed URLs
function loadProcessedUrls(filename) {
  try {
    const content = fs.readFileSync(filename, "utf8").trim();
    return content ? JSON.parse(content) : [];
  } catch (error) {
    console.error(`Error loading ${filename}:`, error.message);
    return [];
  }
}

// Save progress to file
function saveProgress(url, filename) {
  try {
    const processedUrls = loadProcessedUrls(filename);
    if (!processedUrls.includes(url)) {
      processedUrls.push(url);
      fs.writeFileSync(filename, JSON.stringify(processedUrls, null, 2));
    }
  } catch (error) {
    console.error(`Error saving to ${filename}:`, error.message);
  }
}

// Scrape single URL with retries
async function scrapeUrl(url, retryCount = 0) {
  try {
    // First check if this is a URL we want to process
    if (!isTargetUrl(url)) {
      saveProgress(url, CONFIG.nonMatchFile);
      return null;
    }

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

    if (!tireData.name || !tireData.sizeNo) {
      throw new Error("Essential data (name/size) not found on page");
    }
    // Only mark as success if data is complete
    saveProgress(url, CONFIG.successFile);
    return tireData;
  } catch (error) {
    const maxRetries = isTargetUrl(url)
      ? CONFIG.maxRetries
      : CONFIG.maxRetriesForNonMatches;
    if (retryCount < maxRetries) {
      const delay = 1000 * (retryCount + 1);
      console.log(
        `Retrying ${url} in ${delay}ms (${retryCount + 1}/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return scrapeUrl(url, retryCount + 1);
    }
    if (isTargetUrl(url)) {
      saveProgress(url, CONFIG.failedFile);
    } else {
      saveProgress(url, CONFIG.nonMatchFile);
    }
    throw error;
  }
}

// Scrape tire data from page
function scrapeTireData($, url) {
  const getText = (selector, ) => {
    try {
      const result = $(selector).text().trim();
      return result || '';
    } catch {
      return '';
    }
  };

  const getAttribute = (selector, attr,  ) => {
    try {
      const result = $(selector).attr(attr);
      return result || '';
    } catch {
      return '';
    }
  };

  const extractBrand = (productName) => {
    if (!productName) return "";
    return productName.split(" ")[0] || "";
  };

  const parseSizeComponents = (sizeStr) => {
    if (!sizeStr) return { width: "", ratio: "", rim: "" };
    const match = sizeStr.match(/(\d+)\/(\d+)\s*R(\d+)/);
    if (match) {
      return {
        width: match[1],
        ratio: match[2],
        rim: `R${match[3]}`,
      };
    }
    return { width: "", ratio: "", rim: "" };
  };

  const calculateDiscountedPrice = (priceStr) => {
    if (!priceStr) return "";
    const numericMatch = priceStr.match(/[\d,]+\.?\d*/);
    if (!numericMatch) return priceStr;
    const numericValue = parseFloat(numericMatch[0].replace(/,/g, ""));
    if (isNaN(numericValue)) return priceStr;
    const discountedPrice = numericValue - 5; // Apply 5  discount
    const currencyPart = priceStr.replace(numericMatch[0], "");
    return `${currencyPart}${discountedPrice.toFixed(2)}`;
  };
   const calculateDiscountedsetPrice = (priceStr) => {
    if (!priceStr) return "";
    const numericMatch = priceStr.match(/[\d,]+\.?\d*/);
    if (!numericMatch) return priceStr;
    const numericValue = parseFloat(numericMatch[0].replace(/,/g, ""));
    if (isNaN(numericValue)) return priceStr;
    const discountedPrice = numericValue - 20; // Apply 20 discount
    const currencyPart = priceStr.replace(numericMatch[0], "");
    return `${currencyPart}${discountedPrice.toFixed(2)}`;
  };

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

  const sizeComponents = parseSizeComponents(sizeNo);
  const brand = extractBrand(name);
  const price =
    $('span[id^="product-price-"]').first().text().trim() ||
    $(".price-final").text().trim() ||
    $(".regular-price").text().trim();
const vehicleTypeImage = $('img.v_type').attr('src') || '';

  const originalSetPrice = getText("div.set_price span.price");

  const tireData = {
    url: url,
    name: name,
    brand: brand,
    sizeNo: sizeNo,
    price: calculateDiscountedPrice(price),
    width: sizeComponents.width,
    ratio: sizeComponents.ratio,
    rim: sizeComponents.rim,
    setprice: calculateDiscountedsetPrice(originalSetPrice),
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
      ?.trim(),
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
    runFlatImage: getAttribute(
      '.product_detail_right div.detail_left li img[title="Run Flat"]',
      "src"
    ),
    offerText: getText("div.offer_block_inner span.large_text"),
    offerDescription: getText("div.offer_block_inner p.offer_desc"),
    tyreType: "Run Flat",
    tyreWidth: getText("span.tire_width"),
    tyreAspectRatio: getText("span.tire_aspect_ratio"),
    catagory: "Tyres",
    vehicleTypeImage: vehicleTypeImage,
  };

  $("div.product_detail_right tr").each((i, row) => {
    const label = $(row).find("td").first().text().trim();
    const value = $(row).find("td").last().text().trim();
  });

  return tireData;
}

// Load existing data
function loadExistingData() {
  try {
    if (fs.existsSync(CONFIG.jsonOutputFile)) {
      const content = fs.readFileSync(CONFIG.jsonOutputFile, "utf8").trim();
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
    let existingData = [];
  const validNewData = newData.filter(item => 
    item && item.url && item.name && item.sizeNo && item.price
  );

    if (validNewData.length === 0 && !finalSave) {
      return;
    }

    try {
      if (fs.existsSync(CONFIG.jsonOutputFile)) {
        const content = fs.readFileSync(CONFIG.jsonOutputFile, "utf8").trim();
        existingData = content ? JSON.parse(content) : [];
      }
    } catch (error) {
      console.error("Error loading existing data:", error.message);
    }

    const existingUrls = new Set(existingData.map((item) => item.url));
    const mergedData = [...existingData];

    for (const newItem of validNewData) {
      if (newItem && newItem.url && !existingUrls.has(newItem.url)) {
        mergedData.push(newItem);
        existingUrls.add(newItem.url);
      }
    }

    fs.writeFileSync(
      CONFIG.jsonOutputFile,
      JSON.stringify(mergedData, null, 2)
    );

    if (finalSave || validNewData.length > 0) {
      const excelData = mergedData.map((item) => ({
        URL: item.url,
        "Product Name": item.name,
        Brand: item.brand,
        "Size No": item.sizeNo,
        Price: item.price,
        "Set Price": item.setprice,
        "Service Description": item.serviceDesc,
        Country: item.Country,
        UTQG: item.UTQG,
        Year: item.manufactureYear,
        "Sidewall Style": item.wheelColor,
        Description: item.description,
        Title: item.title,
        Rating: item.rating,
        "SKU ID": item.skuId,
        "Logo URL": item.logo,
        "Tire Image": item.tyreImage,
        "Run Flat Image": item.runFlatImage || "",
        "Offer Text": item.offerText,
        "Offer Description": item.offerDescription,
        "Tyre Type": item.runFlatImage ? item.tyreType : "",
        Width: item.width,
        Ratio: item.ratio,
        Rim: item.rim,
        Category: item.catagory,
        "Vehicle Type Image": item.vehicleTypeImage || "",
      }));

      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(excelData);
      XLSX.utils.book_append_sheet(workbook, worksheet, "Tire Data");

      const tempFile = path.join(__dirname, "temp_tireData.xlsx");
      XLSX.writeFile(workbook, tempFile);

      if (fs.existsSync(tempFile)) {
        fs.renameSync(tempFile, CONFIG.outputFile);
      } else {
        XLSX.writeFile(workbook, CONFIG.outputFile);
      }
    }

    console.log(
      `✅ Saved ${mergedData.length} records (${validNewData.length} new)`
    );
  } catch (error) {
    console.error("Error saving output files:", error.message);
  }
  // 
}

// Process URLs in batches with concurrency control
async function processUrlsInBatches(urls) {
  const results = [];
  let processedCount = 0;
  const totalBatches = Math.ceil(urls.length / CONFIG.maxConcurrentRequests);

  for (let i = 0; i < urls.length; i += CONFIG.maxConcurrentRequests) {
    const batch = urls.slice(i, i + CONFIG.maxConcurrentRequests);
    const batchNumber = Math.floor(i / CONFIG.maxConcurrentRequests) + 1;
    console.log(`Processing batch ${batchNumber} of ${totalBatches}`);

    const batchPromises = batch.map((url) =>
      scrapeUrl(url)
        .then((result) => {
          processedCount++;
          if (result) {
            saveProgress(url, CONFIG.successFile);
            return result;
          } else {
            saveProgress(url, CONFIG.nonMatchFile);
            return null;
          }
        })
        .catch((error) => {
          processedCount++;
          console.error(`Error processing ${url}:`, error.message);
          return null;
        })
    );

    const batchResults = await Promise.all(batchPromises);
    const successfulResults = batchResults.filter((result) => result !== null);

    results.push(...successfulResults);

    // Save progress periodically
    if (
      processedCount % CONFIG.saveInterval === 0 ||
      i + CONFIG.maxConcurrentRequests >= urls.length
    ) {
      await saveData(successfulResults, false);
    }

    // Delay between batches
    if (i + CONFIG.maxConcurrentRequests < urls.length) {
      await new Promise((resolve) =>
        setTimeout(resolve, CONFIG.delayBetweenRequests)
      );
    }
  }

  return results.filter((result) => result !== null);
}

// Main scraper function
async function runScraper() {
  console.log("🚀 Starting scraper...");
  initializeFiles();

  try {
    const urls = await fetchSitemapUrls();
    if (urls.length === 0) {
      throw new Error("No URLs found to process");
    }

    const successUrls = loadProcessedUrls(CONFIG.successFile);
    const failedUrls = loadProcessedUrls(CONFIG.failedFile);
    const nonMatchUrls = loadProcessedUrls(CONFIG.nonMatchFile);

    const urlsToProcess = urls.filter(
      (url) =>
        !successUrls.includes(url) &&
        !failedUrls.includes(url) &&
        !nonMatchUrls.includes(url)
    );

    console.log(`
📊 Statistics:
  Total URLs in sitemap: ${urls.length}
  Already processed: ${successUrls.length}
  Previously failed: ${failedUrls.length}
  Non-matching URLs skipped: ${nonMatchUrls.length}
  New URLs to process: ${urlsToProcess.length}
    `);

    if (urlsToProcess.length === 0) {
      console.log("✅ No new URLs to process");
      return;
    }

    const newTireData = await processUrlsInBatches(urlsToProcess);

    // Final save with all data
    await saveData(newTireData, true);

    const existingData = loadExistingData();
    const finalSuccessUrls = loadProcessedUrls(CONFIG.successFile);
    const finalFailedUrls = loadProcessedUrls(CONFIG.failedFile);
    const finalNonMatchUrls = loadProcessedUrls(CONFIG.nonMatchFile);

    console.log(`
🎉 Scraping completed!
  New records added: ${newTireData.length}
  Total records now: ${existingData.length}
  Successfully processed URLs: ${finalSuccessUrls.length}
  Failed URLs: ${finalFailedUrls.length}
  Non-matching URLs: ${finalNonMatchUrls.length}
  Output files:
    - ${CONFIG.outputFile}
    - ${CONFIG.jsonOutputFile}
    - ${CONFIG.successFile}
    - ${CONFIG.failedFile}
    - ${CONFIG.nonMatchFile}
      `);
  } catch (error) {
    console.error("💥 Fatal scraper error:", error.message);
  } finally {
    console.log("Scraping completed");
  }
}

// Start the scraper
runScraper();
