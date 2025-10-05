require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const morgan = require("morgan");
const nodemailer = require("nodemailer");
const stripe = require("stripe")(process.env.PAYMENT_SECRET_KEY);

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

// send email using nodemailer
const sendEmail = (emailAddress, emailData) => {
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false, // true for 465, false for other ports
    auth: {
      user: process.env.NODEMAILER_USER,
      pass: process.env.NODEMAILER_PASS,
    },
  });
  transporter.verify((error, success) => {
    if (error) {
      console.log(error);
    } else {
      console.log("Ready to send email", success);
    }
  });

  const mailBody = {
    from: process.env.NODEMAILER_USER,
    to: emailAddress,
    subject: emailData.subject,
    // text: emailData.message,
    html: `<p>${emailData.message}</p>`,
  };

  transporter.sendMail(mailBody, (err, info) => {
    if (err) {
      console.log(err);
    } else {
      console.log("Email sent: " + info.response);
    }
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
    // await client.connect();
    console.log("✅ Connected to MongoDB");

    const db = client.db("plantnet");
    const usersCollection = db.collection("users");
    const plantsCollection = db.collection("plants");
    const ordersCollection = db.collection("orders");

    //! ---------------------------verify admin middleware---------
    const verifyAdmin = async (req, res, next) => {
      const email = req.user?.email;
      const query = { email };
      const result = await usersCollection.findOne(query);
      if (!result || result?.role !== "admin") {
        return res
          .status(403)
          .send({ message: "forbidden access! Admin only access!" });
      }

      next();
    };
    //! ---------------------------verify seller middleware---------
    const verifySeller = async (req, res, next) => {
      const email = req.user?.email;
      const query = { email };
      const result = await usersCollection.findOne(query);
      if (!result || result?.role !== "seller") {
        return res
          .status(403)
          .send({ message: "forbidden access! Seller only access!" });
      }

      next();
    };

    //!---------------users related apis--------------------------
    app.post("/users/:email", async (req, res) => {
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
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // update a user role n status
    app.patch(
      "/user/role/:email",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const email = req.params.email;
        const { role } = req.body;
        const filter = { email };
        const updateDoc = {
          $set: { role, status: "Verified" },
        };
        const result = await usersCollection.updateOne(filter, updateDoc);
        res.send(result);
      }
    );

    // get user role
    app.get("/users/role/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });

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

    //! -------------------save plant data in db-------------------------
    // Update plant info - PATCH endpoint
app.patch("/plants/:id", verifyToken, verifySeller, async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;
    const userEmail = req.user.email;

    // Validate ObjectId
    let objectId;
    try {
      objectId = new ObjectId(id);
    } catch (err) {
      return res.status(400).send({ error: "Invalid plant id format" });
    }

    // First, check if the plant exists and belongs to the seller
    const existingPlant = await plantsCollection.findOne({ _id: objectId });
    if (!existingPlant) {
      return res.status(404).send({ error: "Plant not found" });
    }

    // Check if the plant belongs to the current seller
    if (existingPlant.seller.email !== userEmail) {
      return res.status(403).send({ error: "Unauthorized: You can only update your own plants" });
    }

    // Prepare update object, excluding fields that shouldn't be updated
    const allowedUpdates = ['name', 'category', 'description', 'price', 'quantity', 'image'];
    const updateObject = {};
    
    allowedUpdates.forEach(field => {
      if (updateData[field] !== undefined) {
        updateObject[field] = updateData[field];
      }
    });

    // Add timestamp for when the plant was last updated
    updateObject.updatedAt = new Date();

    // Perform the update
    const result = await plantsCollection.updateOne(
      { _id: objectId },
      { $set: updateObject }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ error: "Plant not found" });
    }

    if (result.modifiedCount === 0) {
      return res.status(200).send({ 
        message: "No changes detected", 
        acknowledged: true,
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount
      });
    }

    // Return success response
    res.status(200).send({
      acknowledged: true,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      message: "Plant updated successfully"
    });

  } catch (error) {
    console.error("Error updating plant:", error);
    res.status(500).send({ error: "Internal server error while updating plant" });
  }
});

    app.post("/plants", verifyToken, verifySeller, async (req, res) => {
      const plant = req.body;
      const result = await plantsCollection.insertOne(plant);
      res.send(result);
    });

    // get all plants
    app.get("/plants", async (req, res) => {
      const result = await plantsCollection.find().limit(20).toArray();
      res.send(result);
    });

    // get inventory data for seller
    app.get("/plants/seller", verifyToken, verifySeller, async (req, res) => {
      const email = req.user.email;
      const result = await plantsCollection
        .find({ "seller.email": email })
        .toArray();
      res.send(result);
    });

    // delete a plant from db by seller
    app.delete("/plants/:id", verifyToken, verifySeller, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await plantsCollection.deleteOne(query);
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

    // update plant info here
    
 

    //!--------------- order related data in db---------------

    // save order info to db
    app.post("/order", verifyToken, async (req, res) => {
      const orderInfo = req.body;
      console.log(orderInfo);
      const result = await ordersCollection.insertOne(orderInfo);
      if (result.insertedId) {
        // send confirmation email to customer
        sendEmail(orderInfo?.customer?.email, {
          subject: "Order Confirmation - plantNet",
          message: `Your order has been successfully placed! We will notify you once it's shipped. Thank you for choosing plantNet!
          [Transaction ID: ${result.insertedId}]
          `,
        });
        // to seller
        sendEmail(orderInfo?.seller, {
          subject: "New Order Received - plantNet",
          message: `You have received a new order. Please process the order promptly.
          Customer name : ${orderInfo?.customer?.name},
          [Transaction ID: ${result.insertedId}]
          `,
        });
      }
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
    // get orders via single seller email
    app.get(
      "/seller-orders/:email",
      verifyToken,
      verifySeller,
      async (req, res) => {
        const email = req.params.email;
        const result = await ordersCollection
          .aggregate([
            { $match: { seller: email } },
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
      }
    );
    // update a oder status
    app.patch("/order/:id", verifyToken, verifySeller, async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { status },
      };
      const result = await ordersCollection.updateOne(filter, updateDoc);
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

    // admin stats
    app.get("/admin-stat", verifyToken, verifyAdmin, async (req, res) => {
      const totalUsers = await usersCollection.estimatedDocumentCount();
      const totalPlants = await plantsCollection.estimatedDocumentCount();

      // Chart data - get aggregated data by date
      const chartData = await ordersCollection
        .aggregate([
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%d/%m/%Y",
                  date: { $toDate: "$_id" },
                },
              },
              quantity: { $sum: "$quantity" },
              price: { $sum: "$price" },
              order: { $sum: 1 },
            },
          },
          {
            $project: {
              date: "$_id",
              quantity: 1,
              price: 1,
              order: 1,
              _id: 0,
            },
          },
          {
            $sort: { date: 1 }, // Sort by date
          },
        ])
        .toArray(); // Use toArray() to get an array of documents

      // Get total revenue and orders
      const orderDetails = await ordersCollection
        .aggregate([
          {
            $group: {
              _id: null,
              totalRevenue: { $sum: "$price" },
              totalOrder: { $sum: 1 },
            },
          },
          {
            $project: {
              _id: 0,
              totalRevenue: 1,
              totalOrder: 1,
            },
          },
        ])
        .next();

      // Extract values with fallbacks
      const totalRevenue = orderDetails?.totalRevenue || 0;
      const totalOrder = orderDetails?.totalOrder || 0;

      res.send({
        totalUsers,
        totalPlants,
        totalRevenue,
        totalOrder,
        chartData,
      });
    });

    //!-----------payment related --------------------

    // create payment intent
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      const { quantity, plantId } = req.body;
      const plant = await plantsCollection.findOne({
        _id: new ObjectId(plantId),
      });
      if (!plant) {
        return res.status(400).send({ message: "Plant Not Found" });
      }
      const totalPrice = quantity * plant.price * 100; // total price in cents

      // Stripe minimum amount validation (50 cents for USD)
      if (totalPrice < 50) {
        return res.status(400).send({
          message: "Amount must be at least $0.50 USD for payment processing",
        });
      }

      const { client_secret } = await stripe.paymentIntents.create({
        amount: Math.round(totalPrice), // Ensure it's an integer
        currency: "usd",
        automatic_payment_methods: {
          enabled: true,
        },
      });
      res.send({ clientSecret: client_secret });
    });

    // Confirm connection
    // await client.db("admin").command({ ping: 1 });
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
