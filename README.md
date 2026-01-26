# Senior Project Dashboard
## Step 0
```
node -v
npm -v
mysql --version
```

## Step 1
Check Folder:
```
dashboard/
├─ backend/
├─ frontend/
└─ database.sql
```

## Step 2
In backend Folder <dashboard\backend\\> <br><br>

Normal Dependencies:
```
npm init -y
npm install express mysql2 cors dotenv nodemon
```
Dev Dependency:
```
npm install -D nodemon
```

## Step 3
in <backend/package.json>
```
"scripts": {
  "start": "node server.js",
  "dev": "nodemon server.js"
}
```
While test:
```
npm start
```
While code:
```
npm run dev
```

## Step 4
In frontend Folder <dashboard\frontend\\>
```
npm init -y
npm install live-server
```
Then run
```
npx live-server
```
## Step 5
in <frontend/package.json>
```
"scripts": {
  "start": "live-server --host=0.0.0.0 --port=5500 --no-browser"
}
```
then run
```
npm start
```

## Note 1
Change API in <frontend/script.js>
```
const API = "http://backend_IP:5000/api"
```
Check by run
```
ipconfig
```




