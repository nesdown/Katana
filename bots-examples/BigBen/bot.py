# _*_ coding: utf-8 _*_

import datetime
import katana


# Initialize Twitter API, api.update_status(status=sth) is for posts
# Use OAuth2 with simplified api key/token declaring
#katana.apiKey = 'rr1KGkjUxP1SviZx4gpt4in62'
#katana.apiSecret = '1gcZZrl2VYbfkkMj9GnLec9ceuMELtwv3oSGuvdmhony4YgCO4'
#katana.accessToken = '741968262917918720-BN4VNth0CWihAkSMumhoTr8wv3mBFZu'
#katana.accessTokenSecret = 'XI1gxIcb4niuAiP1RXY1IJ98EIWin1IS0SlZUJBaym3cA'
#katana.authorizeBot()



while True:
  now = datetime.datetime.now()

  katana.runSimpleBot("привет!",5)


