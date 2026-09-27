const {
  getPrice,
} = require('./fetch_price');

BASE_URL = "https://demo.inelabteamdev.com";
async function sample_function() {
    let page = 2;
    const limit = 20;
    const LISTINGS_URL = `${BASE_URL}/api/v2/listings?page=${page}&limit=${limit}`;
    const res = await fetch(LISTINGS_URL, {
        headers:{
            "accept": "application/json",
        }
    });
    const data = await res.text();
    console.dir(JSON.parse(data));
}




async function sample_function_2() {
    const item_id = 2030;
    const ITEM_ID_URL = `${BASE_URL}/api/v2/items/${item_id}`;
    const res = await fetch(ITEM_ID_URL, {
        headers:{
            "accept": "application/json",
        }
    });
    const data = await res.text();
    console.dir(JSON.parse(data));
}

