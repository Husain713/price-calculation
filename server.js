// server.js
import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(bodyParser.json());

const SHOP = process.env.SHOP_NAME;
const TOKEN = process.env.ADMIN_TOKEN;
const API_VER = process.env.API_VERSION || "2024-10";
const GRAPHQL = `https://${SHOP}.myshopify.com/admin/api/${API_VER}/graphql.json`;

const GRAPHQL_URL = `https://${SHOP}.myshopify.com/admin/api/${API_VER}/graphql.json`;

const jobStatus = {
  running: false,
  total: 0,
  processed: 0,
  failed: 0,
  startedAt: null,
  variants: [] // live rows for UI
};


const HEADERS = {
  "X-Shopify-Access-Token": TOKEN,
  "Content-Type": "application/json"
};



app.get("/health", async (req, res) => {
  try {
    const response = await axios.post(
      `https://${process.env.SHOP_NAME}.myshopify.com/admin/api/2024-10/graphql.json`,
      {
        query: `{ shop { name } }`
      },
      {
        headers: {
          "X-Shopify-Access-Token": process.env.ADMIN_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );

    return res.json(response.data);
  } catch (err) {
    console.error("Shopify error:", err.response?.data);
    return res.status(401).json(err.response?.data);
  }
});



/* ----------------------------------------------------
   ROUTE: LIST PRODUCTS
---------------------------------------------------- */
app.get("/products", async (req, res) => {
  try {
    // const products = await fetchProducts();
    const products = await fetchAllProducts2();
    const formatted = products.map(({ node }) => ({
      product_id: node.id,
      product_title: node.title,
      product_metafields: node.metafields.edges.map(m => ({
        key: `${m.node.namespace}.${m.node.key}`,
        value: m.node.value
      })),
      variants: node.variants.edges.map(v => ({
        variant_id: v.node.id,
        variant_title: v.node.title,
        price: v.node.price,
        // variant_metafields: v.node.metafields.edges.map(m => ({
        //   key: `${m.node.namespace}.${m.node.key}`,
        //   value: m.node.value
        // }))
      }))
    }));

    return res.json(formatted);
  } catch (err) {
    console.error("Shopify error:", err.response?.data || err.message);
    return res.status(500).json({ error: "Failed to fetch products" });
  }
});


async function updateVariantPrice(productId , variantId, newPrice) {
  const response = await axios.post(
    `https://${process.env.SHOP_NAME}.myshopify.com/admin/api/2024-10/graphql.json`,
    {
      query: `
      mutation UpdateVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants {
            id
            price
          }
          userErrors {
            field
            message
          }
        }
      }
      `,
      variables: {
        productId,
        variants: [
          {
            id: variantId,
            price: newPrice.toString()
          }
        ]
      }
    },
    {
      headers: {
        "X-Shopify-Access-Token": process.env.ADMIN_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );

  if (response.data.errors) {
    throw new Error(response.data.errors[0].message);
  }

 // console.log("🔍 FULL SHOPIFY RESPONSE:");
  console.dir(response.data, { depth: null });

  return response.data;
}



app.get("/update-price-2x", async (req, res) => {
  try {
    const products = await fetchProducts();

    const updates = [];
    updates.push(updateVariantPrice("gid://shopify/Product/8446016979140", "gid://shopify/ProductVariant/45460342407364", 6000.00));

    // return res.json({ success: true, updated: updates.length });
    // for (const { node } of products) {
    //   for (const v of node.variants.edges) {
    //     const oldPrice = parseFloat(v.node.price);
    //     const newPrice = (oldPrice * 2).toFixed(2);
    //     updates.push(updateVariantPrice(v.node.id, newPrice));
    //   }
    // }

    await Promise.all(updates);
    return res.json({ success: true, updated: updates });

  } catch (err) {
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: "Price update failed" });
  }
});




app.get("/update-price", async (req, res) => {
    console.log("Received request:req.query", req.query);
  try {
    const { variantGid, goldPricePerGram, diamondPricePerCarat } = req.body;
    if (!variantGid || !goldPricePerGram) return res.status(400).send({error:"missing inputs"});

    // 1) Fetch variant metafields in namespace "jewellery"
    const fetchMfQuery = `
      query {
        node(id: "${variantGid}") {
          ... on ProductVariant {
            id
            metafields(first: 20, namespace: "jewellery") {
              edges {
                node { key value type }
              }
            }
          }
        }
      }`;
    const mfResp = await axios.post(GRAPHQL, { query: fetchMfQuery }, {
      headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" }
    });

    const edges = mfResp.data.data.node?.metafields?.edges || [];
    const mf = {};
    edges.forEach(({node})=>{
      // value is string; parseFloat where appropriate
      mf[node.key] = parseFloat(node.value) || 0;
    });

    console.log("Metafields:", mf);

    // expected keys: gold_weight (grams), making_charge, diamond_carat, certification_charge
    const goldCost = (mf.gold_weight || 0) * parseFloat(goldPricePerGram);
    const diamondCost = (mf.diamond_carat || 0) * (parseFloat(diamondPricePerCarat) || 0);
    const making = mf.making_charge || 0;
    const cert = mf.certification_charge || 0;

    let final = goldCost + diamondCost + making + cert;
    // optional markup, GST etc can be added here
    final = Math.round(final * 100) / 100; // two decimals

    // // 2) Update variant price
    // const mutation = `
    //   mutation {
    //     productVariantUpdate(input: {
    //       id: "${variantGid}",
    //       price: "${final.toFixed(2)}"
    //     }) {
    //       productVariant { id price }
    //       userErrors { field message }
    //     }
    //   }`;
    // const updateResp = await axios.post(GRAPHQL, { query: mutation }, {
    //   headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" }
    // });

    // const userErrors = updateResp.data.data.productVariantUpdate.userErrors;
    // if (userErrors && userErrors.length) return res.status(500).json({error:userErrors});

    // res.json({
    //   success: true,
    //   variant: updateResp.data.data.productVariantUpdate.productVariant,
    //   breakdown: { goldCost, diamondCost, making, cert, final }
    // });

  } catch (err) {
    console.error(err.response?.data || err.message || err);
    res.status(500).json({ error: "update failed", details: err.response?.data || err.message });
  }
});


app.get("/", (req, res) => {
  res.send("Hello, Shopify Gold Price Calculation App!");
});


app.get("/update-gold-price0", async (req, res) => {
  try {
    const products = await fetchProducts();

    
     // const updates = [];
    // updates.push(updateVariantPrice("gid://shopify/Product/8446016979140", "gid://shopify/ProductVariant/45460342407364", 6000.00));
    const  newGoldPrice  = 13000;
    const  mkcost  = 2000;
    const  diaq1  = 12000;
    const  diaq2  = 8000;
    const  crtfConst = 1500

    let metalcost, diamondcost,making_charge, finalprice;


     let mWeight = 0;
     let dWeight = 0;

     let kt = 0;
     let dquality = 0;
    
    products.forEach(({ node, index }) => {
        let pid = node.id
        console.log("Product ID:",pid);
        node.variants.edges.forEach(v => {
        let variantId = v.node.id;
        let options = v.node.title;
        let variantPrice = v.node.price;
              
        let kt = 0;
        let dquality = 0;

   

        // Split into metal/color and quality
        const [metalColor, quality] = options.split("/").map(s => s.trim());
         // console.log('fist',dquality);  
        // Extract kt and mcolor
        const [ktPart, mcolor] = metalColor.split("-");
        kt = ktPart.replace("KT", ""); // remove "KT"
        dquality = quality;

       /// console.log(pid, variantId,options,variantPrice, kt, mcolor, dquality);
       // console.log(dquality);

        // console.log(kt);        // "14"
        // console.log(mcolorFinal); // "Rose"
        // console.log(dquality);  // "GH I1-I2"

        
      v.node.metafields?.edges.forEach(({ node: m }) => {  
        // productMetafields[`${m.namespace}.${m.key}`] = m.value;
         if(m.key === "metal_weight"){ 
            mWeight = parseFloat(m.value);
            metalcost = (mWeight * newGoldPrice * (kt / 24).toFixed(2));
            console.log("Metal Cost:",metalcost);
            making_charge = mkcost * mWeight;
           // console.log("Making Charge:",making_charge, "mWeight:",mWeight , "metalcost:",metalcost, "kt:",kt, "mcolor:",mcolor);
         } 
        // console.log('dquality:',dquality);

         if(m.key === "diamond_total_weight"){ 
            dWeight = parseFloat(m.value);
              console.log("dquality:",dquality);
            if(dquality === "HI SI"){
                diamondcost = dWeight * diaq1;
              //   console.log("Diamond Cost:",diamondcost, "dWeight:",dWeight , "dquality:",dquality);
            } else if(dquality === "GH I1-I2") {
                diamondcost = dWeight * diaq2;
                // console.log("Diamond Cost:",diamondcost, "dWeight:",dWeight , "dquality:",dquality);
            }
           
         }

         if(metalcost != 0 && diamondcost != 0 && making_charge !=0) {
           finalprice = metalcost + diamondcost + making_charge + crtfConst;

            console.log(`Final Price for Variant ${pid} ${variantId} (${options}):`, finalprice);
            console.log("Final Price Calculation Details:");
            console.log("Metal Cost:",metalcost);
            console.log("Diamond Cost:",diamondcost);
            console.log("Making Charge:",making_charge);
            console.log("Certification Charge:",crtfConst);
            

           metalcost = diamondcost = making_charge = dWeight = dquality = ""; // reset for next variant
         } 
      });


    });

   });


    res.json(products);
   
    const formatted = products.map(({ node }) => {
      const productMetafields = {};
      node.metafields?.edges.forEach(({ node: m }) => {  
        productMetafields[`${m.namespace}.${m.key}`] = m.value;
      });

    
      return {
        product_id: node.id,
        product_title: node.title,
        product_metafields: productMetafields,
       
        variants: node.variants.edges.map(v => {
          const variantMetafields = {};
          v.node.metafields?.edges.forEach(({ node: m }) => {
            variantMetafields[`${m.namespace}.${m.key}`] = m.value;
          });

          return {
            variant_id: v.node.id,
            variant_title: v.node.title,
            price: parseFloat(v.node.price),
            variant_metafields: variantMetafields
          };
        })
      };
    });

   // res.json(formatted);

  } catch (err) {
    console.error("❌ Shopify Error:", err.message);

      console.error("STATUS:", err.response?.status);
  console.error("DATA:", err.response?.data);
  console.error("HEADERS:", err.response?.headers);
  res.status(500).json(err.response?.data || err.message);


    res.status(500).json({ error: "Failed to fetch products" });


  }
});

app.post("/update-price-final", async (req, res) => {
  try {

     const {
      newGoldPrice,
      mkcost,
      diaq1,
      diaq2,
      stonePrice,
      crtfConst
    } = req.body;

    console.log("Received inputs:", req.body);

    if (!newGoldPrice || !mkcost || !diaq1 || !diaq2 || !crtfConst || !stonePrice) {
      return res.status(400).json({  success: false, error: "Missing inputs" });
    }
 
    const products = await fetchAllProducts();
    const updates = [];
    const results = [];


    products.forEach(({ node: product }) => {


    // const  newGoldPrice  = 13000;
    // const  mkcost  = 2000;
    // const  diaq1  = 12000;
    // const  diaq2  = 8000;
    // const  crtfConst = 1500



    const pid = product.id;
    const product_title = product.title;
    console.log("Product ID:", pid);

    product.variants.edges.forEach(({ node: variant }) => {
      const variantId = variant.id;
      const options = variant.title;
      const variantPrice = variant.price;

      // Split into metal/color and quality
      const [metalColor, quality] = options.split("/").map(s => s.trim());
      const [ktPart, mcolor] = metalColor.split("-");
      const kt = parseInt(ktPart.replace("KT", ""), 10);
      const dquality = quality;

      let metalCost = 0;
      let diamondCost = 0;
      let stoneCost = 0;
      let makingCharge = 0;
      let mWeight = 0;
      let dWeight = 0;
      let sWeight = 0;

      variant.metafields?.edges.forEach(({ node: m }) => {

        if (m.key === "color_stone_total_weight") {
          sWeight = parseFloat(m.value);
          stoneCost = sWeight * stonePrice;
          console.log("Stone Cost:", stoneCost, "sWeight:", sWeight);
        } 
        if (m.key === "metal_weight") {
          mWeight = parseFloat(m.value);
          metalCost = mWeight * newGoldPrice * (kt / 24);
          makingCharge = mkcost * mWeight;
        }

        if (m.key === "diamond_total_weight") {
          dWeight = parseFloat(m.value);
          if (dquality === "HI SI") {
            diamondCost = dWeight * diaq1;
          } else if (dquality === "GH I1-I2") {
            diamondCost = dWeight * diaq2;
          }
        }

        });

        // ✅ Only calculate final price if all components are ready
        if (metalCost && diamondCost && makingCharge && (diamondCost || stoneCost)) {
          const finalPrice = (metalCost + diamondCost + stoneCost + makingCharge + crtfConst).toFixed(0);
          console.log("metalCost:", metalCost, "diamondCost:", diamondCost, "stoneCost:", stoneCost, "makingCharge:", makingCharge, "certification:", crtfConst);

          updates.push(updateVariantPrice(pid, variantId, finalPrice));

          console.log(`Final Price for Variant ${pid} ${variantId} ${product_title} (${options}):  sWeight:${sWeight} mWeight:${mWeight} dWeight:${dWeight}`, finalPrice);
          // console.log("Calculation Details:", {
          //   metalCost,
          //   diamondCost,
          //   stoneCost,
          //   makingCharge,
          //   certification: crtfConst
          // });

          // Push result into array
          results.push({
            productTitle:product_title,
            productId: pid,
            variantId,
            options,
            mWeight,
            dWeight,
            sWeight,
            oldPrice: variantPrice,
            finalPrice,
            details: {
              metalCost,
              diamondCost,
              stoneCost,
              makingCharge,
              certification: crtfConst
            }
          });



          // Reset for next variant
          metalCost = 0;
          diamondCost = 0;
          makingCharge = 0;
          mWeight = 0;
          dWeight = 0;
          stoneCost = 0;
        }
      
    });
  });



  await Promise.all(updates);
    return res.json({ success: true, updated: updates ,variants: results  });

  } catch (err) {
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: "Price update failed" });
  }


});


app.post("/update-gold-price", async (req, res) => {
  try {

     const {
      newGoldPrice,
      mkcost,
      diaq1,
      diaq2,
      stonePrice,
      crtfConst
    } = req.body;

    
    // const  newGoldPrice  = 13000;
    // const  mkcost  = 2000;
    // const  diaq1  = 12000;
    // const  diaq2  = 8000;
    // const  crtfConst = 1500
    // const  stonePrice = 3000;

    //console.log("Received inputs:", req.body);

    if (!newGoldPrice || !mkcost || !diaq1 || !diaq2 || !crtfConst || !stonePrice) {
      return res.status(400).json({  success: false, error: "Missing inputs" });
    }

      let i = 0

    const products = await fetchAllProducts2();

    //res.json(products);

    const updates = [];
    const results = [];

    
    products.forEach(({ node: product }) => {


    // const  newGoldPrice  = 13000;
    // const  mkcost  = 2000;
    // const  diaq1  = 12000;
    // const  diaq2  = 8000;
    // const  crtfConst = 1500



    const pid = product.id;
    const product_title = product.title;
    //console.log("Product ID:", pid);

    // Process metafields here
        let metalCost = 0;
        let diamondCost = 0;
        let stoneCost = 0;
        let makingCharge = 0;
        let mWeight = 0;
        let dWeight = 0;
        let sWeight = 0;
        let mWeight9kt = 0;
        let mWeight14kt = 0;
        let mWeight18kt = 0;
        let dCount = 0;
      

    product.metafields?.edges.forEach(({ node: m }) => {
      
      // i = i.toFixed(0) + vi.toFixed(0);
    // console.log(`Product Metafield - Key: ${m.key}, Value: ${m.value}`);
      if (m.key === "9kt_metal_weight" && m.value !== null && m.value !== "" && m.value !== "-") {
           mWeight9kt = parseFloat(m.value);
      }
      if (m.key === "14kt_metal_weight" && m.value !== null && m.value !== "" && m.value !== "-") {
           mWeight14kt = parseFloat(m.value);
      }
      if (m.key === "18kt_metal_weight" && m.value !== null && m.value !== "" && m.value !== "-") {
           mWeight18kt = parseFloat(m.value);
      }
      if (m.key === "diamond_count" && m.value !== null && m.value !== "" && m.value !== "-") {
           dCount = parseFloat(m.value);
      }
      if (m.key === "diamond_total_weight" && m.value !== null && m.value !== "" && m.value !== "-") {
           dWeight = parseFloat(m.value);
      } 
      if (m.key === "gemstone_total_weight" && m.value !== null && m.value !== "" && m.value !== "-") {
           sWeight = parseFloat(m.value);
      }
     
    });

    
    product.variants.edges.forEach(({ node: variant }) => {
      const variantId = variant.id;
      const options = variant.title;
      const variantPrice = variant.price;

      //console.log("Product Weights - 9kt:", mWeight9kt, "14kt:", mWeight14kt, "18kt:", mWeight18kt, "dCount:", dCount, "dWeight:", dWeight, "sWeight:", sWeight);


      // Split into metal/color and quality
      const [metalColor, quality] = options.split("/").map(s => s.trim());
      const [ktPart, mcolor] = metalColor.split("-");
      let kt = parseInt(ktPart.replace("KT", ""), 10);
     
      const dquality = quality;

      // let metalCost = 0;
      // let diamondCost = 0;
      // let stoneCost = 0;
      // let makingCharge = 0;
      // let mWeight = 0;
      // let dWeight = 0;
      // let sWeight = 0;


        if(kt == 9 && mWeight9kt!= 0) {
          metalCost = mWeight9kt * newGoldPrice * (kt / 24);
          makingCharge = mkcost * mWeight9kt;
         // console.log("9kt_metal_weight mWeight:",mWeight9kt);

        }

         if(kt == 14 && mWeight14kt != 0) {
          metalCost = mWeight14kt * newGoldPrice * (kt / 24);
          makingCharge = mkcost * mWeight14kt;
        //  console.log("14kt_metal_weight mWeight:",mWeight14kt);
        }

         if(kt == 18 && mWeight18kt != 0) {
          metalCost = mWeight18kt * newGoldPrice * (kt / 24);
          makingCharge = mkcost * mWeight18kt;
        //  console.log("18kt_metal_weight mWeight:",mWeight18kt);
        }

        if (sWeight != 0) {
          // sWeight = parseFloat(m.value);
          stoneCost = sWeight * stonePrice;
         // console.log("Stone Cost:", stoneCost, "sWeight:", sWeight);
        } 


         if (dWeight != 0) {
          // dWeight = parseFloat(m.value);
          if (dquality === "HI SI") {
            diamondCost = dWeight * diaq1;
          } else if (dquality === "GH I1-I2") {
            diamondCost = dWeight * diaq2;
          }
        }


      // variant.metafields?.edges.forEach(({ node: m }) => {
      //    console.log('kt:',kt);
     
      //   // if (m.key === "metal_weight") {
      //   //   mWeight = parseFloat(m.value);
      //   //   metalCost = `${mWeight}kt` * newGoldPrice * (kt / 24);
      //   //   makingCharge = mkcost * mWeight;
      //   // }

      //   // if(kt === 14 && getProductMetaValue(product.metafields?.edges, "14kt_metal_weight")) {
      //   //   mWeight = parseFloat(getProductMetaValue(product.metafields?.edges, "14kt_metal_weight"));
      //   //   console.log("14kt_metal_weight mWeight:",mWeight);
      //   // }
      

      //   });

        // ✅ Only calculate final price if all components are ready

       // if (metalCost && makingCharge && (diamondCost || stoneCost)) {
          const finalPrice = (metalCost + diamondCost + stoneCost + makingCharge + crtfConst).toFixed(0);
          //console.log("metalCost:", metalCost, "diamondCost:", diamondCost, "stoneCost:", stoneCost, "makingCharge:", makingCharge, "certification:", crtfConst);

          if (!finalPrice || isNaN(finalPrice) || finalPrice <= 0) {
            console.warn(`Skipping product ${pid} variant ${variant.id} - invalid price`, finalPrice);
          } else {
            
          // await new Promise(r => setTimeout(r, 100));
            updates.push(updateVariantPrice(pid, variantId, finalPrice));
          }




          console.log(`${i++} Final Price for Variant ${pid} ${variantId} ${product_title} (${options}):  sWeight:${sWeight} mWeight:${mWeight} dWeight:${dWeight}  finalPrice: ${finalPrice}` );
          // console.log("Calculation Details:", {
          //   metalCost,
          //   diamondCost,
          //   stoneCost,
          //   makingCharge,
          //   certification: crtfConst
          // });

          // Push result into array
          results.push({
            productTitle:product_title,
            productId: pid,
            variantId,
            options,
            mWeight,
            dWeight,
            sWeight,
            oldPrice: variantPrice,
            finalPrice,
            details: {
              metalCost,
              diamondCost,
              stoneCost,
              makingCharge,
              certification: crtfConst
            }
          });



          // Reset for next variant
          metalCost = 0;
          diamondCost = 0;
          makingCharge = 0;
          mWeight = 0;
          dWeight = 0;
          stoneCost = 0;
       // }

         
      
    });
  });

  

  await Promise.all(updates);
    console.log("Total Products Fetched:", products.length);
  
    return res.json({ success: true, updated: updates ,variants: results  });
  } catch (err) {
    console.error(err.response?.data || err.message);
    return res.status(500).json({ error: "Price update failed", details: err.response?.data || err.message });
  }
});


app.get("/update-gold-price-final/status", (req, res) => {
  res.json(jobStatus);
});



app.post("/update-gold-price-final", async (req, res) => {
  try {
    if (jobStatus.running) {
      return res.status(409).json({ success: false, error: "Job already running" });
    }

    const {
      newGoldPrice,
      mkcost,
      diaq1,
      diaq2,
      stonePrice,
      crtfConst
    } = req.body;

    if (
      !newGoldPrice ||
      !mkcost ||
      !diaq1 ||
      !diaq2 ||
      !stonePrice ||
      !crtfConst
    ) {
      return res.status(400).json({ success: false, error: "Missing inputs" });
    }

    // 🔄 Start job
    jobStatus.running = true;
    jobStatus.processed = 0;
    jobStatus.failed = 0;
    jobStatus.startedAt = Date.now();

    // Respond immediately (do NOT block browser)
    res.json({ success: true, message: "Price update started" });

    const products = await fetchAllProducts2();
    const results = [];

    // 🔢 Count total variants first
    jobStatus.total = products.reduce(
      (sum, p) => sum + (p.node.variants?.edges?.length || 0),
      0
    );

    // 🔁 PROCESS PRODUCTS
    for (const { node: product } of products) {
      const pid = product.id;
      const productTitle = product.title;

      let mWeight9kt = 0;
      let mWeight14kt = 0;
      let mWeight18kt = 0;
      let dWeight = 0;
      let sWeight = 0;

      product.metafields?.edges.forEach(({ node: m }) => {
        if (m.value === "-" || m.value === "" || m.value == null) return;

        const v = parseFloat(m.value);
        if (isNaN(v)) return;

        if (m.key === "9kt_metal_weight") mWeight9kt = v;
        if (m.key === "14kt_metal_weight") mWeight14kt = v;
        if (m.key === "18kt_metal_weight") mWeight18kt = v;
        if (m.key === "diamond_total_weight") dWeight = v;
        if (m.key === "gemstone_total_weight") sWeight = v;
      });

      for (const { node: variant } of product.variants.edges) {
        try {
          let metalCost = 0;
          let diamondCost = 0;
          let stoneCost = 0;
          let makingCharge = 0;

          const [metalPart, quality] = variant.title.split("/").map(s => s.trim());
          const kt = parseInt(metalPart?.replace("KT", ""), 10);

          if (kt === 9 && mWeight9kt) {
            metalCost = mWeight9kt * newGoldPrice * (kt / 24);
            makingCharge = mkcost * mWeight9kt;
          }
          if (kt === 14 && mWeight14kt) {
            metalCost = mWeight14kt * newGoldPrice * (kt / 24);
            makingCharge = mkcost * mWeight14kt;
          }
          if (kt === 18 && mWeight18kt) {
            metalCost = mWeight18kt * newGoldPrice * (kt / 24);
            makingCharge = mkcost * mWeight18kt;
          }

          if (sWeight) stoneCost = sWeight * stonePrice;

          if (dWeight) {
            if (quality === "HI SI") diamondCost = dWeight * diaq1;
            if (quality === "GH I1-I2") diamondCost = dWeight * diaq2;
          }

          const finalPrice = Math.round(
            metalCost +
            diamondCost +
            stoneCost +
            makingCharge +
            crtfConst
          );

          if (!finalPrice || finalPrice <= 0 || isNaN(finalPrice)) {
            jobStatus.failed++;
            continue;
          }

          // 🔥 THROTTLED UPDATE (NO Promise.all)
          await updateVariantPrice(pid, variant.id, finalPrice);
          jobStatus.processed++;

          results.push({
            productTitle,
            productId: pid,
            variantId: variant.id,
            options: variant.title,
            oldPrice: variant.price,
            finalPrice
          });

          // 🧘 Shopify-safe delay
          await sleep(600);

        } catch (err) {
          jobStatus.failed++;
          console.error("Variant update failed:", err.response?.data || err.message);
        }
      }
    }

    jobStatus.running = false;
    console.log("✅ Job completed");

  } catch (err) {
    jobStatus.running = false;
    console.error(err);
  }
});



// latest version with detailed tracking

app.get("/update-gold-price-final02/status", (req, res) => {
  res.json(jobStatus);
});

app.get("/update-gold-price-final02/variants", (req, res) => {
  res.json(jobStatus);
});


app.post("/update-gold-price-final02", async (req, res) => {
  if (jobStatus.running) {
    return res.status(409).json({ error: "Job already running" });
  }

  const {
    newGoldPrice,
    mkcost,
    diaq1,
    diaq2,
    stonePrice,
    crtfConst
  } = req.body;

  if (!newGoldPrice || !mkcost || !diaq1 || !diaq2 || !stonePrice || !crtfConst) {
    return res.status(400).json({ error: "Missing inputs" });
  }

  // // reset job
  // Object.assign(jobStatus, {
  //   running: true,
  //   processed: 0,
  //   failed: 0,
  //   startedAt: Date.now(),
  //   variants: []
  // });

  // reset job
  Object.assign(jobStatus, {
    running: true,
    processed: 0,
    failed: 0,
    startedAt: Date.now(),
    variants: []
  });


  // respond immediately
  res.json({ success: true, message: "Price update started" });

  const products = await fetchAllProducts();

  jobStatus.total = products.reduce(
    (sum, p) => sum + p.node.variants.edges.length,
    0
  );

 console.log("Total products to process:", jobStatus.total);

  for (const { node: product } of products) {
    const pid = product.id;
    const title = product.title;

    let m9 = 0, m14 = 0, m18 = 0, dWeight = 0, sWeight = 0;

    product.metafields.edges.forEach(({ node }) => {
      const v = parseFloat(node.value);
      if (isNaN(v)) return;
      if (node.key === "9kt_metal_weight") m9 = v;
      if (node.key === "14kt_metal_weight") m14 = v;
      if (node.key === "18kt_metal_weight") m18 = v;
      if (node.key === "diamond_total_weight") dWeight = v;
      if (node.key === "gemstone_total_weight") sWeight = v;
    });

    for (const { node: variant } of product.variants.edges) {
      let metalCost = 0, diamondCost = 0, stoneCost = 0, makingCharge = 0;

      const [metalPart, quality] = variant.title.split("/").map(s => s.trim());
      const kt = parseInt(metalPart?.replace("KT", ""), 10);

      if (kt === 9 && m9) {
        metalCost = m9 * newGoldPrice * (kt / 24);
        makingCharge = mkcost * m9;
      }
      if (kt === 14 && m14) {
        metalCost = m14 * newGoldPrice * (kt / 24);
        makingCharge = mkcost * m14;
      }
      if (kt === 18 && m18) {
        metalCost = m18 * newGoldPrice * (kt / 24);
        makingCharge = mkcost * m18;
      }

      if (sWeight) stoneCost = sWeight * stonePrice;
      if (dWeight) {
        if (quality === "HI SI") diamondCost = dWeight * diaq1;
        if (quality === "GH I1-I2") diamondCost = dWeight * diaq2;
      }

      const finalPrice = Math.round(
        metalCost + diamondCost + stoneCost + makingCharge + crtfConst
      );

      const row = {
        productId: pid,
        productTitle: title,
        variantId: variant.id,
        options: variant.title,
        oldPrice: variant.price,
        finalPrice,
        status: "updating",
        details: {
          metalCost,
          diamondCost,
          makingCharge,
          stoneCost,
          certification: crtfConst
        }
      };

      jobStatus.variants.push(row);

      try {
        if (finalPrice > 0) {
          await updateVariantPrice(pid, variant.id, finalPrice);
          row.status = "success";
          jobStatus.processed++;
        } else {
          row.status = "failed";
          jobStatus.failed++;
        }
      } catch {
        row.status = "failed";
        jobStatus.failed++;
      }

      await sleep(600); // 🔥 throttling protection
    }
  }

  jobStatus.running = false;
});




//app.listen(process.env.PORT || 3000, ()=>console.log("Server running"));
//app.use(express.static("public"));


const sleep = ms => new Promise(r => setTimeout(r, ms));


function getProductMetaValue(productMetafields, key) {
  const field = productMetafields.find(item => item.key === key);
  console.log(`Searching for key: ${key}, Found field:`, field);
  return field ? field.value : null; // return null if key not found
}




/* ----------------------------------------------------
   HELPER: FETCH PRODUCTS + VARIANTS + METAFIELDS
---------------------------------------------------- */
async function fetchProducts() {
  const response = await axios.post(
    `https://${process.env.SHOP_NAME}.myshopify.com/admin/api/2024-10/graphql.json`,
    {
      // query: `
      // {
      //   products(first: 250) {
      //     edges {
      //       node {
      //         id
      //         title
      //         metafields(first: 10) {
      //           edges {
      //             node {
      //               namespace
      //               key
      //               value
      //             }
      //           }
      //         }
      //         variants(first: 10) {
      //           edges {
      //             node {
      //               id
      //               title
      //               price
      //               metafields(first: 10) {
      //                 edges {
      //                   node {
      //                     namespace
      //                     key
      //                     value
      //                   }
      //                 }
      //               }
      //             }
      //           }
      //         }
      //       }
      //     }
      //   }
      // }
      // `

       query: `
      {
        products(first: 250) {
          edges {
            node {
              id
              title
              metafields(first: 10) {
                edges {
                  node {
                    namespace
                    key
                    value
                  }
                }
              }
              variants(first: 10) {
                edges {
                  node {
                    id
                    title
                    price   
                  }
                }
              }
            }
          }
        }
      }
      `
    },
    {
      headers: {
        "X-Shopify-Access-Token": process.env.ADMIN_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data.data.products.edges;
}



async function fetchAllProducts() {
  let allProducts = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await axios.post(
      `https://${process.env.SHOP_NAME}.myshopify.com/admin/api/2024-10/graphql.json`,
      {
        // query: `
        // query ($cursor: String) {
        //   products(first: 10, after: $cursor,query: "status:active") {
        //     pageInfo {
        //       hasNextPage
        //     }
        //     edges {
        //       cursor
        //       node {
        //         id
        //         title
        //         metafields(first: 20) {
        //           edges {
        //             node {
        //               namespace
        //               key
        //               value
        //             }
        //           }
        //         }
        //         variants(first: 250) {
        //           edges {
        //             node {
        //               id
        //               title
        //               price
        //               metafields(first: 20) {
        //                 edges {
        //                   node {
        //                     namespace
        //                     key
        //                     value
        //                   }
        //                 }
        //               }
        //             }
        //           }
        //         }
        //       }
        //     }
        //   }
        // }
        // `,
         query: `
                query ($cursor: String) {
            products(first: 5, after: $cursor, query: "status:active") {
            pageInfo {
              hasNextPage
            }
            edges {
              cursor
              node {
                id
                title
                metafields(first: 20) {
                  edges {
                    node {
                      namespace
                      key
                      value
                    }
                  }
                }
                variants(first: 250) {
                  edges {
                    node {
                      id
                      title
                      price
                    }
                  }
                }
              }
            }
          }
        }

        `,
        variables: { cursor }
      },
      {
        headers: {
          "X-Shopify-Access-Token": process.env.ADMIN_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );

    // ❌ Shopify GraphQL error
    if (response.data.errors) {
      console.error("Shopify GraphQL Errors:", response.data.errors);
      throw new Error("GraphQL error");
    }

    const productsBlock = response?.data?.data?.products;

    // 🔒 STOP if empty page
    if (!productsBlock?.edges?.length) break;

    // for (const edge of productsBlock.edges) {
    //   if (!edge?.node?.id) continue;

    //   const product = edge.node;

    //   const productMetafields =
    //     product.metafields?.edges?.map(m => ({
    //       key: `${m.node.namespace}.${m.node.key}`,
    //       value: m.node.value
    //     })) || [];

    //   const variants =
    //     product.variants?.edges
    //       ?.filter(v => v?.node?.id)
    //       .map(v => ({
    //         id: v.node.id,
    //         title: v.node.title,
    //         price: v.node.price,
    //         metafields:
    //           v.node.metafields?.edges?.map(m => ({
    //             key: `${m.node.namespace}.${m.node.key}`,
    //             value: m.node.value
    //           })) || []
    //       })) || [];

    //   allProducts.push({
    //     id: product.id,
    //     title: product.title,
    //     metafields: productMetafields,
    //     variants
    //   });
    // }

    hasNextPage = productsBlock.pageInfo.hasNextPage;
    cursor = productsBlock.edges.at(-1)?.cursor || null;

    allProducts = allProducts.concat(response.data.data.products.edges);
  }

  return allProducts;
}


async function fetchAllProducts2() {
  let allProducts = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await axios.post(
      `https://${process.env.SHOP_NAME}.myshopify.com/admin/api/2024-10/graphql.json`,
      {
        query: `
        query ($cursor: String) {
          products(first: 10, after: $cursor, query: "status:active") {
            pageInfo {
              hasNextPage
            }
            edges {
              cursor
              node {
                id
                title
                metafields(first: 20) {
                  edges {
                    node {
                      namespace
                      key
                      value
                    }
                  }
                }
                variants(first: 250) {
                  edges {
                    node {
                      id
                      title
                      price
                    }
                  }
                }
              }
            }
          }
        }
        `,
        variables: { cursor }
      },
      {
        headers: {
          "X-Shopify-Access-Token": process.env.ADMIN_TOKEN,
          "Content-Type": "application/json"
        }
      }
    );

    // ❌ GraphQL-level errors
    if (response.data.errors) {
      console.error("❌ Shopify GraphQL Errors:", response.data.errors);
      break;
    }

    const productsBlock = response?.data?.data?.products;

    // 🔒 Safety check
    if (!productsBlock?.edges?.length) {
      console.log("✅ No more products");
      break;
    }

    allProducts.push(...productsBlock.edges);

    hasNextPage = productsBlock.pageInfo.hasNextPage;
    cursor = productsBlock.edges.at(-1)?.cursor || null;

    // 🧘 Throttle protection
    await new Promise(r => setTimeout(r, 100));
  }

  return allProducts;
}


app.get("/product", async (req, res) => {
  try {
    //const products = await fetchProducts();
    const products = await fetchAllProducts();

    const formatted = products.map(({ node }) => {
      const productMetafields = {};
      node.metafields?.edges.forEach(({ node: m }) => {
        productMetafields[`${m.namespace}.${m.key}`] = m.value;
      });

      return {
        product_id: node.id,
        product_title: node.title,
        product_metafields: productMetafields,

        variants: node.variants.edges.map(v => {
          const variantMetafields = {};
          v.node.metafields?.edges.forEach(({ node: m }) => {
            variantMetafields[`${m.namespace}.${m.key}`] = m.value;
          });

          return {
            variant_id: v.node.id,
            variant_title: v.node.title,
            price: parseFloat(v.node.price),
            variant_metafields: variantMetafields
          };
        })
      };
    });

    res.json(formatted);

  } catch (err) {
    console.error("❌ Shopify Error:", err.message);

      console.error("STATUS:", err.response?.status);
  console.error("DATA:", err.response?.data);
  console.error("HEADERS:", err.response?.headers);
  res.status(500).json(err.response?.data || err.message);


    res.status(500).json({ error: "Failed to fetch products" });


  }
});

