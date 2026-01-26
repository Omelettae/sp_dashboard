# Senior Project Dashboard
## Step 0
```
node -v
npm -v
mysql --version
```

## Step 1
Create Folder:
```
dashboard/
├─ backend/
└─ frontend/
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
npm install live-server
```
Then run
```
npx live-server
```




