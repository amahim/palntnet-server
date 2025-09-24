require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const morgan = require("morgan");

const port = process.env.PORT || 5000;
const app = express();
// middleware
const corsOptions = {
  origin: ["http://localhost:5173", "http://localhost:5174"],
  credentials: true,
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(cookieParser());
app.use(morgan("dev"));

const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      console.log(err);
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.user = decoded;
    next();
  });
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.kreq4.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    // Make sure MongoDB client is connected
    await client.connect();
    console.log("✅ Connected to MongoDB");

    const db = client.db("plantnet");
    const usersCollection = db.collection("users");
    const plantsCollection = db.collection("plants");
    const ordersCollection = db.collection("orders");

    //!---------------users related apis--------------------------
    app.post("/users/:email", async (req, res) => {
      console.log("📩 Hit /users/:email"); // debug log

      const email = req.params.email;
      const query = { email };
      const user = req.body;

      // check if user exists in db
      const isExist = await usersCollection.findOne(query);
      if (isExist) {
        return res.send({ message: "user already exists" });
      }

      const result = await usersCollection.insertOne({
        ...user,
        role: "customer",
        timeStamp: Date.now(),
      });

      res.send(result);
    });

    // get all users
    app.get("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = {email:{
        $ne: email
      }}
      const result = await usersCollection.find(query).toArray();
      res.send(result);
    });

    // get user role
    app.get("/users/role/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({email});
      
      res.send({ role: result?.role });
    });

    // manager role n status of user
    app.patch("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user?.status === "Requested") {
        return res.status(400).send("Already Requested ");
      }
      //  const {status} = req.body;
      const updateDoc = {
        $set: { status: "Requested" },
      };
      const result = await usersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // ✅ JWT route
    app.post("/jwt", async (req, res) => {
      const email = req.body;
      const token = jwt.sign(email, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "365d",
      });
      res
        .cookie("token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        })
        .send({ success: true });
    });

    // ✅ Logout
    app.get("/logout", async (req, res) => {
      try {
        res
          .clearCookie("token", {
            maxAge: 0,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
          })
          .send({ success: true });
      } catch (err) {
        res.status(500).send(err);
      }
    });

    // ! -------------------save plant data in db-------------------------

    app.post("/plants", verifyToken, async (req, res) => {
      const plant = req.body;
      const result = await plantsCollection.insertOne(plant);
      res.send(result);
    });

    // get all plants
    app.get("/plants", async (req, res) => {
      const result = await plantsCollection.find().limit(20).toArray();
      res.send(result);
    });

    // get plant by id
    app.get("/plants/:id", async (req, res) => {
      const { id } = req.params;
      let objectId;
      try {
        objectId = new ObjectId(id);
      } catch (err) {
        return res.status(400).send({ error: "Invalid plant id format" });
      }
      const plant = await plantsCollection.findOne({ _id: objectId });
      if (!plant) {
        return res.status(404).send({ error: "Plant not found" });
      }
      res.send(plant);
    });

    // get a plant by id
    app.get("/plants/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await plantsCollection.findOne(query);
      res.send(result);
    });

    //!--------------- order related data in db---------------

    // save order info to db
    app.post("/order", verifyToken, async (req, res) => {
      const orderInfo = req.body;
      console.log(orderInfo);
      const result = await ordersCollection.insertOne(orderInfo);
      res.send(result);
    });
    // get all orders from db
    app.get("/order", verifyToken, async (req, res) => {
      const result = await ordersCollection.find().toArray();
      res.send(result);
    });

    // get orders via single cutomer email
    app.get("/customer-orders/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const result = await ordersCollection
        .aggregate([
          { $match: { "customer.email": email } },
          {
            $addFields: {
              plantId: { $toObjectId: "$plantId" },
            },
          },
          {
            $lookup: {
              from: "plants",
              localField: "plantId",
              foreignField: "_id",
              as: "plants",
            },
          },
          {
            $unwind: "$plants",
          },
          {
            $addFields: {
              plantName: "$plants.name",
              plantImage: "$plants.image",
              plantQuantity: "$plants.quantity",
            },
          },
          {
            $project: {
              plants: 0,
            },
          },
        ])
        .toArray();
      res.send(result);
    });

    // manage plant quantity after order
    app.patch("/plants/quantity/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const { updatedQuantity, status } = req.body;
      const filter = { _id: new ObjectId(id) };
      let updateDoc = {
        $inc: { quantity: -updatedQuantity },
      };
      if (status === "increase") {
        updateDoc = {
          $inc: { quantity: updatedQuantity },
        };
      }
      const result = await plantsCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // cancel/dlt an order
    app.delete("/order/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const order = await ordersCollection.findOne(query);
      if (order.status === "Delivered") {
        return res.status(409).send("Delivered order can't be cancelled");
      }
      const result = await ordersCollection.deleteOne(query);
      res.send(result);
    });

    // Confirm connection
    await client.db("admin").command({ ping: 1 });
    console.log("🚀 Pinged your deployment. MongoDB connected!");
  } finally {
    // Don't close client here — keep connection alive for server
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from plantNet Server..");
});

app.listen(port, () => {
  console.log(`plantNet is running on port ${port}`);
});
