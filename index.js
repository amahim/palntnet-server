require('dotenv').config()
const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const jwt = require('jsonwebtoken')
const morgan = require('morgan')

const port = process.env.PORT || 5000
const app = express()
// middleware
const corsOptions = {
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true,
  optionSuccessStatus: 200,
}
app.use(cors(corsOptions))

app.use(express.json())
app.use(cookieParser())
app.use(morgan('dev'))

const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token


  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' })
  }
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      console.log(err)
      return res.status(401).send({ message: 'unauthorized access' })
    }
    req.user = decoded
    next()
  })
}



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.kreq4.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})
async function run() {
  try {
    // Make sure MongoDB client is connected
    await client.connect()
    console.log("✅ Connected to MongoDB")

    const db = client.db('plantnet')
    const usersCollection = db.collection('users')
    const plantsCollection = db.collection('plants')

    //!---------------users related apis--------------------------
    app.post('/users/:email', async (req, res) => {
      console.log("📩 Hit /users/:email")  // debug log

      const email = req.params.email
      const query = { email }
      const user = req.body

      // check if user exists in db
      const isExist = await usersCollection.findOne(query)
      if (isExist) {
        return res.send({ message: 'user already exists' })
      }

      const result = await usersCollection.insertOne({
        ...user,
        role:"customer",
        timeStamp: Date.now()
      })

      res.send(result)
    })

    // ✅ JWT route
    app.post('/jwt', async (req, res) => {
      const email = req.body
      const token = jwt.sign(email, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: '365d',
      })
      res
        .cookie('token', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
        })
        .send({ success: true })
    })

    // ✅ Logout
    app.get('/logout', async (req, res) => {
      try {
        res
          .clearCookie('token', {
            maxAge: 0,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict',
          })
          .send({ success: true })
      } catch (err) {
        res.status(500).send(err)
      }
    })

    // ! -------------------save plant data in db-------------------------
    
    app.post('/plants',verifyToken,async (req, res) => {
      const plant = req.body
      const result = await plantsCollection.insertOne(plant)
      res.send(result)
    })

    // get all plants
    app.get('/plants', async (req, res) => {
      const result = await plantsCollection.find().limit(20).toArray()
      res.send(result)
    })



    // Confirm connection
    await client.db('admin').command({ ping: 1 })
    console.log('🚀 Pinged your deployment. MongoDB connected!')
  } finally {
    // Don't close client here — keep connection alive for server
  }
}

run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('Hello from plantNet Server..')
})

app.listen(port, () => {
  console.log(`plantNet is running on port ${port}`)
})
